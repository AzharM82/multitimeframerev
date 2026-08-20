/**
 * MASTER watchlist snapshot -> tools/tv-avwap/watchlist_master.txt
 *
 * Why this exists: the operator adds and removes names in TradingView, and
 * nothing outside DESKTOP2 can see that. The published rows show the CURRENT
 * universe but not what changed, so a symbol quietly leaving looks identical to
 * a symbol that failed to read. Committing a sorted snapshot turns every
 * watchlist edit into a reviewable git diff that DEV can see without asking.
 *
 * Read-only against TradingView: it calls the same `jsWatchlist` the publisher
 * uses, changes no symbol, and touches no chart state.
 *
 *   node dump_watchlist.mjs            # snapshot + show what changed
 *   node dump_watchlist.mjs --check    # show what changed, write nothing (exit 1 if drifted)
 *
 * Workflow after editing the watchlist:
 *   node dump_watchlist.mjs
 *   git add tools/tv-avwap/watchlist_master.txt
 *   git commit -m "watchlist: +ABC -XYZ"   &&  git push
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { jsWatchlist } from "./chart_js.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "watchlist_master.txt");
const CHECK = process.argv.includes("--check");

const PORT = Number(process.env.TV_CDP_PORT || 9222);
const NAME = process.env.TV_WATCHLIST || "MASTER";
const CHART = process.env.TV_CHART_URL || "";

function loadEnv() {
  // Same minimal .env read the publisher does; no dependency on dotenv.
  try {
    for (const line of readFileSync(join(HERE, ".env"), "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}
loadEnv();

async function findChart() {
  const targets = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
  const pages = targets.filter((t) => t.type === "page");
  const want = process.env.TV_CHART_URL || CHART;
  if (want) {
    const bound = pages.find((t) => t.url && t.url.includes(want));
    if (!bound) throw new Error(`TV_CHART_URL="${want}" matched no open chart tab`);
    return bound;
  }
  const any = pages.find((t) => /tradingview\.com\/chart/i.test(t.url || ""));
  if (!any) throw new Error("no TradingView chart tab found");
  return any;
}

function cdp(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params) => new Promise((resolve, reject) => {
    const msgId = ++id;
    const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 30000);
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== msgId) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  return { ready, send, close: () => ws.close() };
}

const page = await findChart();
const { ready, send, close } = cdp(page);
await ready;

const res = await send("Runtime.evaluate", {
  expression: jsWatchlist(NAME),
  returnByValue: true,
  awaitPromise: true,
});
close();

const wl = res.result && res.result.value;
if (!wl || wl.error) {
  console.error(`ERROR: could not read watchlist "${NAME}":`, wl ? wl.error : "no value");
  if (wl && wl.names) console.error("available:", wl.names.join(", "));
  process.exit(5);
}

const symbols = [...new Set(wl.symbols)].sort();
const previous = existsSync(OUT)
  ? readFileSync(OUT, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  : [];

const added = symbols.filter((s) => !previous.includes(s));
const removed = previous.filter((s) => !symbols.includes(s));

console.log(`watchlist ${wl.name} (${wl.id}): ${symbols.length} symbols`);
if (!previous.length) {
  console.log("no previous snapshot - this is the baseline");
} else if (!added.length && !removed.length) {
  console.log("no change since the last snapshot");
} else {
  if (added.length) console.log(`  ADDED   (${added.length}): ${added.join(", ")}`);
  if (removed.length) console.log(`  REMOVED (${removed.length}): ${removed.join(", ")}`);
}

if (CHECK) {
  if (added.length || removed.length) {
    console.log("\n--check: snapshot is stale, nothing written. Re-run without --check to update.");
    process.exit(1);
  }
  process.exit(0);
}

writeFileSync(OUT, symbols.join("\n") + "\n");
console.log(`\nwrote ${OUT}`);
if (added.length || removed.length) {
  const summary = [added.length ? "+" + added.map((s) => s.split(":").pop()).join(" +") : "",
                   removed.length ? "-" + removed.map((s) => s.split(":").pop()).join(" -") : ""]
    .filter(Boolean).join(" ");
  console.log(`commit with:  git commit -m "watchlist: ${summary}"`);
}
