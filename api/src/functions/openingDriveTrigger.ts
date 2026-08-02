import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import { recordAndAlert, type TriggerState, type TriggerFields } from "../lib/openingDrive/alert.js";

/**
 * POST /api/opening-drive-trigger  (x-timer-secret)
 *
 * External state-transition ingestion for Opening Drive. In the cloud-only
 * design the engine (openingDriveEngine) drives Phase 2 directly, but this
 * endpoint is retained so any out-of-band caller (a manual test, a future
 * alternate source) can push a gate/trigger/stuffed/exit transition. It shares
 * the exact record + alert path (`recordAndAlert`) with the engine, so there is
 * one alert format and one row shape.
 *
 * Anonymous route + x-timer-secret, same as scanner-alert / bigdog-alert.
 */

interface TriggerBody extends TriggerFields {
  ticker?: string;
  state?: TriggerState;
  ts?: string;
}

async function openingDriveTriggerHandler(req: HttpRequest): Promise<HttpResponseInit> {
  const secret = req.headers.get("x-timer-secret");
  if (!process.env.TIMER_SECRET || secret !== process.env.TIMER_SECRET) {
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }

  let body: TriggerBody;
  try {
    body = (await req.json()) as TriggerBody;
  } catch {
    return { status: 400, jsonBody: { error: "Invalid JSON body" } };
  }

  const ticker = (body.ticker || "").toUpperCase().trim();
  const state = body.state;
  if (!ticker || !state) {
    return { status: 400, jsonBody: { error: "ticker and state required" } };
  }

  const firedAt = body.ts || new Date().toISOString();
  const partition = firedAt.slice(0, 10);

  try {
    await recordAndAlert(partition, ticker, state, body, firedAt);
    return { jsonBody: { status: "ok", ticker, state, partition } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("openingDriveTrigger", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "opening-drive-trigger",
  handler: openingDriveTriggerHandler,
});
