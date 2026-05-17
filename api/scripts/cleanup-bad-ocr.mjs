/**
 * One-shot: scan AlertLog, cross-check each reversalPrice against a
 * Polygon snapshot, list rows where |ocr - quote| / quote > 0.5 — likely
 * OCR misreads (e.g. INTC $5109.40 vs real $108.77).
 *
 * Usage:
 *   node api/scripts/cleanup-bad-ocr.mjs            # dry-run, prints what it WOULD delete
 *   node api/scripts/cleanup-bad-ocr.mjs --delete   # actually delete those rows
 *
 * Env required:
 *   AZURE_STORAGE_CONNECTION_STRING
 *   POLYGON_API_KEY
 */
import { TableClient } from "@azure/data-tables";

const CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const KEY = process.env.POLYGON_API_KEY;
const TABLE = "AlertLog";
const THRESHOLD = 0.5; // 50% — well clear of normal intraday drift
const DELETE = process.argv.includes("--delete");

if (!CONN) { console.error("AZURE_STORAGE_CONNECTION_STRING not set"); process.exit(1); }
if (!KEY)  { console.error("POLYGON_API_KEY not set"); process.exit(1); }

async function polygonPrice(ticker) {
  const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  const t = json.ticker ?? {};
  return (
    t.lastTrade?.p ||
    t.min?.c ||
    t.day?.c ||
    t.prevDay?.c ||
    null
  );
}

const tbl = TableClient.fromConnectionString(CONN, TABLE);

const all = [];
for await (const e of tbl.listEntities()) all.push(e);
console.log(`Scanning ${all.length} rows in ${TABLE}...`);

// Unique tickers, batch-fetch
const tickers = [...new Set(all.map((r) => r.ticker).filter(Boolean))];
const quotes = new Map();
for (const t of tickers) {
  const p = await polygonPrice(t);
  if (p) quotes.set(t, p);
  await new Promise((r) => setTimeout(r, 50)); // gentle on rate limit
}
console.log(`Got Polygon quotes for ${quotes.size} / ${tickers.length} tickers.`);

const bad = [];
for (const row of all) {
  const ocr = Number(row.reversalPrice);
  const q = quotes.get(row.ticker);
  if (!q || !Number.isFinite(ocr) || ocr <= 0) continue;
  const delta = Math.abs(ocr - q) / q;
  if (delta > THRESHOLD) {
    bad.push({ row, ocr, quote: q, delta });
  }
}

console.log(`\nRows flagged for deletion (delta > ${THRESHOLD * 100}%): ${bad.length}\n`);
console.log("TICKER".padEnd(8) + "OCR".padStart(12) + "QUOTE".padStart(12) + "DELTA%".padStart(12) + "  partition/rowKey");
console.log("-".repeat(80));
for (const b of bad) {
  const dpct = (b.delta * 100).toFixed(0).padStart(11);
  console.log(
    b.row.ticker.padEnd(8) +
    `$${b.ocr.toFixed(2)}`.padStart(12) +
    `$${b.quote.toFixed(2)}`.padStart(12) +
    `${dpct}%  ` +
    `${b.row.partitionKey} / ${b.row.rowKey}`,
  );
}

if (!DELETE) {
  console.log("\nDRY RUN — nothing deleted. Re-run with --delete to actually remove these rows.");
  process.exit(0);
}

console.log("\nDeleting...");
let deleted = 0;
for (const b of bad) {
  try {
    await tbl.deleteEntity(b.row.partitionKey, b.row.rowKey);
    deleted++;
  } catch (err) {
    console.error(`  failed for ${b.row.partitionKey}/${b.row.rowKey}: ${err.message}`);
  }
}
console.log(`Deleted ${deleted} / ${bad.length} rows.`);
