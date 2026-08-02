import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { listByPartition, TABLES } from "../lib/tables.js";
import { fetchIexBars, isAlpacaConfigured } from "../lib/alpaca.js";
import { loadConfig } from "../lib/openingDrive/config.js";
import { buildSlotBaseline, evaluateCandidate, type CandidateState, type EngineStateOut } from "../lib/openingDrive/engine.js";
import { recordAndAlert, type TriggerState, type TriggerFields } from "../lib/openingDrive/alert.js";
import type { Bar } from "../lib/openingDrive/trigger.js";

/**
 * POST /api/opening-drive-engine  (x-timer-secret)
 *
 * Phase 2, cloud-only. Fired every 2 minutes by mtfrev-cron during the 9 & 10
 * o'clock hours; self-gates to the 9:30–10:30 ET window and no-ops otherwise.
 * Pulls the day's candidates, fetches their IEX 2-min bars from Alpaca in one
 * call, and runs the shared trigger logic — the same code the replay validates.
 * No local machine, no WebSocket, no persistent host.
 */

function etMinutesNow(d: Date): { mins: number; weekday: string } {
  const s = d.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit", weekday: "short" });
  // s like "Mon, 09:34"
  const wd = s.slice(0, 3);
  const hm = s.match(/(\d{2}):(\d{2})/);
  const mins = hm ? Number(hm[1]) * 60 + Number(hm[2]) : 0;
  return { mins, weekday: wd };
}

function etDayStr(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

interface CandidateRow {
  rowKey: string;
  kind?: string;
  demoted?: boolean;
  regime?: string;
  payloadJson?: string;
}

const STATE_MAP: Record<Exclude<EngineStateOut["kind"], "none">, TriggerState> = {
  GATE_FAIL: "GATE_FAIL",
  GATE_PASS: "GATE_PASS",
  STUFFED: "STUFFED",
  TRIGGERED: "TRIGGERED",
  EXIT: "EXIT",
};

async function openingDriveEngineHandler(req: HttpRequest): Promise<HttpResponseInit> {
  const secret = req.headers.get("x-timer-secret");
  if (!process.env.TIMER_SECRET || secret !== process.env.TIMER_SECRET) {
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }

  const cfg = loadConfig();
  const now = new Date();
  const { mins, weekday } = etMinutesNow(now);

  // Self-gate to the trigger window (config-driven; default 9:30–10:30 ET, weekdays).
  const [sH, sM] = cfg.engineStartEt.split(":").map(Number);
  const [eH, eM] = cfg.monitorStopEt.split(":").map(Number);
  const startMin = sH * 60 + sM;
  const stopMin = eH * 60 + eM;
  const inWindow = weekday !== "Sat" && weekday !== "Sun" && mins >= startMin && mins <= stopMin;
  const force = req.query.get("force") === "1";
  if (!inWindow && !force) {
    return { jsonBody: { status: "skipped", reason: "outside window", etMins: mins, weekday } };
  }

  if (!isAlpacaConfigured()) {
    return { status: 500, jsonBody: { error: "Alpaca credentials not set" } };
  }

  const partition = etDayStr(now);
  const rows = await listByPartition<CandidateRow>(TABLES.OPENING_DRIVE, partition);
  const candidateRows = rows.filter((r) => r.kind === "candidate" && r.payloadJson && !r.demoted);
  if (!candidateRows.length) {
    return { jsonBody: { status: "ok", reason: "no candidates", partition } };
  }

  // Parse candidate state from the persisted payloads.
  const cands: CandidateState[] = [];
  for (const r of candidateRows) {
    try {
      const p = JSON.parse(r.payloadJson as string) as Record<string, unknown>;
      cands.push({
        ticker: (p.ticker as string) ?? r.rowKey,
        priorClose: Number(p.priorClose ?? 0),
        ydayHigh: Number(p.ydayHigh ?? 0),
        catalystType: p.catalystType as string | undefined,
        catalystStrength: p.catalystStrength as string | undefined,
        catalystHeadline: (p.catalystHeadline as string | null) ?? null,
        sectorEtfPct: (p.sectorEtfPct as number | null) ?? null,
        state: (p.state as string | null) ?? null,
        entry: (p.entry as number | null) ?? null,
        stop: (p.stop as number | null) ?? null,
        pmHighUsed: (p.pmHighUsed as number | null) ?? null,
      });
    } catch {
      /* skip unparseable */
    }
  }

  // One Alpaca call covering prior days (RVOL baseline) + today.
  const eightDaysAgo = new Date(now.getTime() - 8 * 86_400_000).toISOString().slice(0, 10);
  const barsBySym = await fetchIexBars(cands.map((c) => c.ticker), "2Min", eightDaysAgo);

  const today = etDayStr(now);
  const transitions: { ticker: string; state: string }[] = [];

  for (const cand of cands) {
    const all = barsBySym.get(cand.ticker) ?? [];
    const todayBars: Bar[] = [];
    const priorBars: Bar[] = [];
    for (const b of all) {
      (etDayStr(new Date(b.timestamp)) === today ? todayBars : priorBars).push(b);
    }
    const baseline = buildSlotBaseline(priorBars);

    const out = evaluateCandidate(cand, todayBars, baseline, cfg, now.getTime());
    if (out.kind === "none") continue;

    const fields: TriggerFields = {
      catalystType: cand.catalystType,
      catalystStrength: cand.catalystStrength,
      headline: cand.catalystHeadline,
      regime: candidateRows[0]?.regime,
      sectorPct: cand.sectorEtfPct,
    };
    if (out.kind === "TRIGGERED") {
      fields.entry = out.entry;
      fields.stop = out.stop;
      fields.pmHigh = out.pmHigh;
      fields.rvol = out.rvol;
      fields.riskPerShare = out.riskPerShare;
      fields.suggestedShares = out.suggestedShares;
      fields.barTimeEt = out.barTimeEt;
    } else if (out.kind === "EXIT") {
      fields.exitReason = out.reason;
      fields.barTimeEt = out.barTimeEt;
    }

    await recordAndAlert(partition, cand.ticker, STATE_MAP[out.kind], fields, now.toISOString());
    transitions.push({ ticker: cand.ticker, state: out.kind });
  }

  return { jsonBody: { status: "ok", partition, candidates: cands.length, transitions } };
}

app.http("openingDriveEngine", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "opening-drive-engine",
  handler: openingDriveEngineHandler,
});
