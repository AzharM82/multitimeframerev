/* eslint-disable no-console */
/**
 * WA Sidecar watchdog — runs every 5 min from the "WA Sidecar Watchdog" task.
 *
 * The sidecar can look green while delivering nothing: Task Scheduler shows the
 * task Running (node is alive) but whatsapp-web.js's puppeteer page has gone to
 * a detached Frame, so every send throws and messages pile up on the queue. The
 * task's own auto-restart only fires on the `disconnected` event, which that
 * failure never raises. This process is the outside observer that catches it.
 *
 * STUCK when any of:
 *   - the "WA Sidecar" task is not Running
 *   - queue depth >= HANG_DEPTH
 *   - queue depth >= 1 AND the last meaningful sidecar.log line is a failure
 *
 * An EMPTY queue is ALWAYS healthy. Alerts are deduped, so long idle gaps are
 * normal — "nothing sent recently" must never on its own raise an alarm.
 *
 * On stuck: restart via schtasks /end + /run (the Task Scheduler service runs
 * these as SYSTEM, so this task needs no elevation to control the elevated
 * sidecar task) and ping Pushover.
 *
 * Logging: appendFileSync here is the SOLE writer of watchdog.log. run_watchdog.bat
 * must NOT also redirect stdout/stderr into it — cmd holding the same file open
 * for a redirect makes these appends throw on a sharing violation, and the
 * failure is invisible (this used to silently log nothing for a week).
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DIR = __dirname;
const SIDECAR_LOG = path.join(DIR, "sidecar.log");
const WATCHDOG_LOG = path.join(DIR, "watchdog.log");
const TASK = "WA Sidecar";
const HANG_DEPTH = 10;
const TAIL_BYTES = 65536;

// sidecar/.env first (queue connstr), then scanner/.env for the Pushover keys.
// dotenv does not overwrite already-set vars, so the sidecar's values win and
// scanner/.env stays the single source of truth for Pushover.
require("dotenv").config({ path: path.join(DIR, ".env") });
require("dotenv").config({
  path: path.join(DIR, "..", "bigdog-scanner", "scanner", ".env"),
});

const QUEUE_NAME = process.env.WHATSAPP_QUEUE_NAME || "whatsapp-alerts";
const FAILURE_LINE =
  /Send failed|FATAL|detached Frame|Target closed|Session closed|Protocol error|Execution context was destroyed|page has been closed|drainOnce error|Poll loop crashed|WA disconnected|auth failure/i;

function note(line) {
  const stamp = new Date().toISOString();
  try {
    fs.appendFileSync(WATCHDOG_LOG, `${stamp} ${line}\n`);
  } catch (err) {
    // Never throw from logging — but do surface it on stderr, which the bat
    // routes to watchdog_boot.log, so a swallowed write is at least visible.
    console.error(`watchdog.log append failed: ${err.message}`);
  }
}

function taskStatus() {
  try {
    const out = execFileSync(
      "schtasks",
      ["/query", "/tn", TASK, "/fo", "csv", "/nh"],
      { encoding: "utf8" }
    );
    const cols = out.trim().split("\n")[0].split('","');
    return (cols[cols.length - 1] || "").replace(/"/g, "").trim();
  } catch (err) {
    return `query-failed(${err.status ?? err.message})`;
  }
}

function lastMeaningfulLogLine() {
  try {
    const { size } = fs.statSync(SIDECAR_LOG);
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = fs.openSync(SIDECAR_LOG, "r");
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split(/\r?\n/).filter((l) => l.trim());
    return lines.length ? lines[lines.length - 1] : "";
  } catch {
    return "";
  }
}

async function queueDepth() {
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) throw new Error("AZURE_STORAGE_CONNECTION_STRING not set");
  const { QueueClient } = require("@azure/storage-queue");
  const q = new QueueClient(connStr, QUEUE_NAME);
  return (await q.getProperties()).approximateMessagesCount;
}

function restartTask() {
  // /end waits for termination, so the IgnoreNew policy cannot silently drop
  // the following /run the way a manual Stop→Start race does.
  try {
    execFileSync("schtasks", ["/end", "/tn", TASK], { stdio: "ignore" });
  } catch {
    /* already stopped — fine */
  }
  execFileSync("schtasks", ["/run", "/tn", TASK], { stdio: "ignore" });
}

async function pushover(message) {
  const token = process.env.PUSHOVER_APP_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) return "pushover:unconfigured";
  try {
    const res = await fetch("https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token,
        user,
        title: "WA Sidecar restarted",
        message,
        priority: "1",
      }),
    });
    const body = await res.json().catch(() => ({}));
    // A 200 with "no active devices to send to" means the ping went NOWHERE —
    // report it rather than logging a misleading success.
    if (body.info) return `pushover:${res.status}:${body.info}`;
    return `pushover:${res.status}`;
  } catch (err) {
    return `pushover:failed:${err.message}`;
  }
}

(async () => {
  const status = taskStatus();
  let depth;
  try {
    depth = await queueDepth();
  } catch (err) {
    note(`ERROR task=${status} queue-check-failed: ${err.message}`);
    process.exit(0);
  }

  const lastLine = lastMeaningfulLogLine();
  const lastFailed = FAILURE_LINE.test(lastLine);

  const reasons = [];
  if (status !== "Running") reasons.push(`task=${status}`);
  if (depth >= HANG_DEPTH) reasons.push(`depth=${depth}>=${HANG_DEPTH}`);
  if (depth >= 1 && lastFailed) reasons.push(`depth=${depth} last-log-failed`);

  if (!reasons.length) {
    note(`ok: task=${status} depth=${depth}`);
    return;
  }

  const why = reasons.join(" ");
  try {
    restartTask();
    const ping = await pushover(`Stuck (${why}) — restarted at ${new Date().toLocaleString()}`);
    note(`STUCK ${why} → restarted; ${ping}`);
  } catch (err) {
    const ping = await pushover(`Stuck (${why}) and RESTART FAILED: ${err.message}`);
    note(`STUCK ${why} → RESTART FAILED: ${err.message}; ${ping}`);
  }
})().catch((err) => {
  note(`ERROR unhandled: ${err.message}`);
  process.exit(0);
});
