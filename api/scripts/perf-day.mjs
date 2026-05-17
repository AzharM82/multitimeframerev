/**
 * Day P&L estimator for a single trading date.
 *
 * For each alert on the given date (partitionKey = YYYY-MM-DD):
 *   entry  = reversalPrice
 *   exit   = that date's daily close from Polygon (1d aggs)
 *   $1K P&L = (exit - entry) / entry * 1000
 *
 * Aggregates: trade count, wins/losses, total/avg P&L, win-rate.
 *
 * Usage:
 *   node api/scripts/perf-day.mjs 2026-05-15
 */
import { TableClient } from "@azure/data-tables";

const CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const KEY  = process.env.POLYGON_API_KEY;
const DATE = process.argv[2];

if (!CONN || !KEY) { console.error("missing env"); process.exit(1); }
if (!DATE || !/^\d{4}-\d{2}-\d{2}$/.test(DATE)) { console.error("usage: perf-day.mjs YYYY-MM-DD"); process.exit(1); }

async function dailyClose(ticker, date) {
  const url = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/${date}/${date}?apiKey=${KEY}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  return j.results?.[0]?.c ?? null;
}

const tbl = TableClient.fromConnectionString(CONN, "AlertLog");
const rows = [];
for await (const e of tbl.listEntities({ queryOptions: { filter: `PartitionKey eq '${DATE}'` } })) rows.push(e);
console.log(`Pulled ${rows.length} alerts for ${DATE}`);

const uniq = [...new Set(rows.map((r) => r.ticker))];
const closes = new Map();
for (const t of uniq) {
  const c = await dailyClose(t, DATE);
  if (c) closes.set(t, c);
  await new Promise((r) => setTimeout(r, 50));
}
console.log(`Got closes for ${closes.size} / ${uniq.length} tickers`);

const trades = [];
for (const r of rows) {
  const c = closes.get(r.ticker);
  if (!c) continue;
  const entry = Number(r.reversalPrice);
  if (!isFinite(entry) || entry <= 0) continue;
  const pnlPct = (c - entry) / entry * 100;
  const pnlDollars = (c - entry) / entry * 1000;
  trades.push({ ticker: r.ticker, time: r.firedAt?.slice(11, 19), entry, close: c, pnlDollars, pnlPct });
}
trades.sort((a, b) => b.pnlDollars - a.pnlDollars);

console.log("");
console.log("TICKER  TIME      ENTRY     CLOSE     $P&L    PCT");
console.log("------  --------  --------  --------  ------  ------");
for (const t of trades) {
  const c = t.pnlDollars >= 0 ? "\x1b[32m" : "\x1b[31m";
  const dollar = `${t.pnlDollars >= 0 ? "+" : "-"}$${Math.abs(t.pnlDollars).toFixed(2)}`;
  const pct = `${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(2)}%`;
  console.log(`${t.ticker.padEnd(6)}  ${(t.time || "").padEnd(8)}  $${t.entry.toFixed(2).padStart(7)}  $${t.close.toFixed(2).padStart(7)}  ${c}${dollar.padStart(6)}  ${pct.padStart(6)}\x1b[0m`);
}

const wins = trades.filter((t) => t.pnlDollars > 0);
const losses = trades.filter((t) => t.pnlDollars < 0);
const flats = trades.filter((t) => t.pnlDollars === 0);
const total = trades.reduce((s, t) => s + t.pnlDollars, 0);
const avg = trades.length ? total / trades.length : 0;
const best = trades.length ? Math.max(...trades.map((t) => t.pnlPct)) : 0;
const worst = trades.length ? Math.min(...trades.map((t) => t.pnlPct)) : 0;

console.log("");
console.log(`SUMMARY — ${DATE} — $1000 per trade, exit at daily close`);
console.log("─".repeat(60));
console.log(`Trades:    ${trades.length} (skipped ${rows.length - trades.length} for missing data)`);
console.log(`Wins:      ${wins.length}`);
console.log(`Losses:    ${losses.length}`);
console.log(`Flat:      ${flats.length}`);
console.log(`Win rate:  ${trades.length ? (wins.length / trades.length * 100).toFixed(1) : 0}%`);
console.log(`Total P&L: ${total >= 0 ? "+" : "-"}$${Math.abs(total).toFixed(2)}`);
console.log(`Avg P&L:   ${avg >= 0 ? "+" : "-"}$${Math.abs(avg).toFixed(2)} per trade`);
console.log(`Best:      +${best.toFixed(2)}%`);
console.log(`Worst:     ${worst.toFixed(2)}%`);
