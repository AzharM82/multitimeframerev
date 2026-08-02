import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { runScan } from "../lib/openingDrive/scan.js";
import { loadConfig } from "../lib/openingDrive/config.js";
import { upsert, TABLES } from "../lib/tables.js";

/**
 * POST /api/opening-drive-scan  (x-timer-secret)
 *
 * Phase 1: run the 9:28 ET pre-market scan and persist the candidate list.
 * Fired by the mtfrev-cron timer, and manually triggerable from the tab.
 *
 * Persistence is idempotent: candidate rows are keyed by ticker under the ET
 * scan-date partition, so re-running the scan upserts rather than duplicating
 * (spec §CROSS-CUTTING idempotency). A `__meta` row holds the regime banner.
 */

async function openingDriveScanHandler(req: HttpRequest): Promise<HttpResponseInit> {
  const secret = req.headers.get("x-timer-secret");
  if (!process.env.TIMER_SECRET || secret !== process.env.TIMER_SECRET) {
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }

  const scanTime = new Date();
  const partition = scanTime.toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  try {
    const result = await runScan(loadConfig(), scanTime);

    await upsert(TABLES.OPENING_DRIVE, partition, "__meta", {
      kind: "meta",
      regime: result.regime,
      spyPct: result.spyPct,
      discovered: result.discovered,
      candidateCount: result.candidates.length,
      asOf: result.asOf,
    });

    for (const c of result.candidates) {
      await upsert(TABLES.OPENING_DRIVE, partition, c.ticker, {
        kind: "candidate",
        asOf: result.asOf,
        regime: result.regime,
        payloadJson: JSON.stringify(c),
        // Denormalized columns for research-agent queries without JSON parsing.
        gapPct: c.gapPct,
        pmHigh: c.pmHigh,
        pmVolume: c.pmVolume,
        pmLast: c.pmLast,
        ydayHigh: c.ydayHigh,
        priorClose: c.priorClose,
        atrPct: c.atrPct,
        ath: c.ath,
        catalystType: c.catalystType,
        catalystStrength: c.catalystStrength,
        sectorEtf: c.sectorEtf ?? "",
        sectorSympathy: c.sectorSympathy,
        demoted: c.demoted,
      });
    }

    return {
      jsonBody: {
        status: "ok",
        partition,
        regime: result.regime,
        discovered: result.discovered,
        candidates: result.candidates.length,
        live: result.candidates.filter((c) => !c.demoted).length,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("openingDriveScan", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "opening-drive-scan",
  handler: openingDriveScanHandler,
});
