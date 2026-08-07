import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { listByPartition, TABLES } from "../lib/tables.js";

/**
 * GET /api/opening-drive-results?date=YYYY-MM-DD&live=1
 *
 * Reads the day's candidate list + regime. Two consumers:
 *   • the portal tab (full candidate objects), and
 *   • the DESKTOP2 Phase-2 scanner, which polls it for the ticker list to watch
 *     (`live=1` returns only non-demoted tickers, the ones to feed ToS).
 *
 * ANONYMOUS: the DESKTOP2 scanner is a machine caller and cannot complete a
 * Google sign-in — same pattern as the sidecar polling /api/tv-request. GET-only
 * exemption is declared in staticwebapp.config.json above the /api/* catch-all.
 */

interface Row {
  rowKey: string;
  kind?: string;
  regime?: string;
  spyPct?: number | null;
  discovered?: number;
  asOf?: string;
  payloadJson?: string;
  demoted?: boolean;
  rejectionsJson?: string;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function openingDriveResultsHandler(req: HttpRequest): Promise<HttpResponseInit> {
  const date =
    (req.query.get("date") || "").trim() ||
    new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const liveOnly = req.query.get("live") === "1";

  try {
    const rows = await listByPartition<Row>(TABLES.OPENING_DRIVE, date);
    const meta = rows.find((r) => r.rowKey === "__meta");
    const candidateRows = rows.filter((r) => r.kind === "candidate" && r.payloadJson);

    const candidates = candidateRows
      .map((r) => {
        try {
          return JSON.parse(r.payloadJson as string);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((c: { demoted?: boolean }) => !liveOnly || !c.demoted);

    // Lightweight ticker list for the DESKTOP2 scanner.
    if (liveOnly && req.query.get("tickersOnly") === "1") {
      return { jsonBody: { date, tickers: candidates.map((c: { ticker: string }) => c.ticker) } };
    }

    return {
      jsonBody: {
        date,
        regime: meta?.regime ?? null,
        spyPct: meta?.spyPct ?? null,
        discovered: meta?.discovered ?? 0,
        asOf: meta?.asOf ?? null,
        count: candidates.length,
        candidates,
        // Why the list is the size it is — present for scans run after 2026-08-07.
        rejections: meta?.rejectionsJson ? safeParse(meta.rejectionsJson) : null,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("openingDriveResults", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "opening-drive-results",
  handler: openingDriveResultsHandler,
});
