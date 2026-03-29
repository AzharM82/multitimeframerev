/**
 * Screener logic — ported from Market Metrics Python backend.
 * Qullamaggie (EP + PS + BO), Minervini, and O'Neil CAN SLIM screeners.
 */

import { fetchExportFromUrl, isEliteConfigured } from "./finvizElite.js";

// ─── FinViz Export URLs ───────────────────────────────────────────────────────

const FINVIZ_EXPORT_URLS: Record<string, string> = {
  qulla_episodic:
    "https://elite.finviz.com/export.ashx?v=141&f=geo_usa,ta_gap_u10,sh_relvol_o2,sh_price_o1,sh_avgvol_o1000&o=-change&c=1,47,61,62,63,64,65",
  qulla_ps_large:
    "https://elite.finviz.com/export.ashx?v=141&f=cap_largeover,geo_usa,ta_perf_50to-4w&o=-change&c=1,47,61,62,63,64,65",
  qulla_ps_small:
    "https://elite.finviz.com/export.ashx?v=141&f=cap_to9,geo_usa,ta_perf_300to-4w,ta_perf2_100to-1w&ft=4&o=-change&c=1,47,61,62,63,64,65",
  qulla_breakouts:
    "https://elite.finviz.com/export.ashx?v=141&f=geo_usa,sh_avgvol_o1000,sh_price_o1,ta_highlow52w_0to25-bhx,ta_perf_30to-4w,tad_0_close::close:d|abvpct::10:|sma:20:sma:d&o=-change&c=1,47,61,62,63,64,65",
  minervini:
    "https://elite.finviz.com/export.ashx?v=141&f=geo_usa,sh_avgvol_o1000,sh_price_o1,ta_sma200_pa,tad_0_sma:150:sma:d|abv:::1|close::close:d,tad_1_sma:200:sma:d|abv:::1|close::close:d,tad_2_sma:200:sma:d|abv:::1|sma:150:sma:d,tad_3_sma:50:sma:d|abv:::|sma:150:sma:d,tad_4_sma:50:sma:d|abv:::|sma:200:sma:d,tad_5_sma:50:sma:d|abv:::1|close::close:d,tad_6_close::close:d|abvpct:30::|hilo:52:low:d,tad_7_close::close:d|blwpct::25:|hilo:52:high:d,tad_8_rsi:14:rsi:d|abveq:::|value:::70&o=-change&c=1,47,61,62,63,64,65",
  oneil:
    "https://elite.finviz.com/export.ashx?v=161&f=fa_epsyoy_o25,fa_epsyoy1_o25,fa_epsyoyttm_pos,fa_netmargin_pos,fa_roe_pos,geo_usa&o=-change&ft=2&c=1,32,40,47,61,62,63,64,65",
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScreenerRow {
  ticker: string;
  price: string;
  change: string;
  volume: string;
  avg_vol: string;
  rel_vol: string;
  atr_pct: number | null;
  tag?: string;
  roe?: number | null;
  net_margin?: number | null;
  news?: string;
  news_url?: string;
}

// ─── In-memory cache (1 hour TTL) ────────────────────────────────────────────

const CACHE_TTL = 3600_000; // 1 hour
const cache = new Map<string, { data: ScreenerRow[]; ts: number }>();

function getCached(key: string): ScreenerRow[] | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function putCache(key: string, data: ScreenerRow[]): void {
  cache.set(key, { data, ts: Date.now() });
}

// ─── CSV field helpers ────────────────────────────────────────────────────────

function findCol(keys: string[], ...substrings: string[]): string | null {
  for (const k of keys) {
    const kl = k.toLowerCase();
    if (substrings.every((s) => kl.includes(s.toLowerCase()))) return k;
  }
  return null;
}

function findColExact(keys: string[], exact: string): string | null {
  const el = exact.toLowerCase();
  for (const k of keys) {
    if (k.trim().toLowerCase() === el) return k;
  }
  return null;
}

function getVal(row: Record<string, string>, ...candidates: string[]): string {
  for (const c of candidates) {
    const v = row[c];
    if (v !== undefined && v.trim() !== "" && v.trim() !== "-") return v;
  }
  // Case-insensitive fallback
  const rowLower = new Map(
    Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]),
  );
  for (const c of candidates) {
    const v = rowLower.get(c.toLowerCase());
    if (v !== undefined && v.trim() !== "" && v.trim() !== "-") return v;
  }
  return "";
}

function parseNum(s: string): number | null {
  if (!s || s === "-") return null;
  const clean = s.replace(/[,$%]/g, "").trim();
  const m = clean.match(/^([\d.\-]+)\s*([KMB])?$/i);
  if (!m) {
    const n = parseFloat(clean);
    return isNaN(n) ? null : n;
  }
  let val = parseFloat(m[1]);
  if (isNaN(val)) return null;
  const suffix = (m[2] ?? "").toUpperCase();
  if (suffix === "K") val *= 1e3;
  else if (suffix === "M") val *= 1e6;
  else if (suffix === "B") val *= 1e9;
  return val;
}

function parsePctVal(val: string): number | null {
  if (!val || val === "-" || val === "\u2014") return null;
  const n = parseFloat(val.replace(/[,%]/g, "").trim());
  return isNaN(n) ? null : n;
}

// ─── Generic screener fetch + parse ───────────────────────────────────────────

async function fetchScreenerFromUrl(
  urlKey: string,
  cacheKey: string,
): Promise<ScreenerRow[]> {
  const cached = getCached(cacheKey);
  if (cached) return cached;

  if (!isEliteConfigured()) return [];
  const url = FINVIZ_EXPORT_URLS[urlKey];
  if (!url) return [];

  const data = await fetchExportFromUrl(url, urlKey);
  if (!data.length) return [];

  const keys = Object.keys(data[0]);
  const tickerCol = findColExact(keys, "Ticker") ?? findCol(keys, "ticker") ?? "Ticker";
  const priceCol = findColExact(keys, "Price") ?? findCol(keys, "price");
  const changeCol = findColExact(keys, "Change") ?? findCol(keys, "change");
  const volCol = findColExact(keys, "Volume") ?? findCol(keys, "volume");
  const avgVolCol = findCol(keys, "average", "vol") ?? findCol(keys, "avg", "vol");
  const relVolCol = findCol(keys, "relative", "vol") ?? findCol(keys, "rel", "vol");
  const atrCol = findColExact(keys, "ATR") ?? findCol(keys, "atr") ?? findCol(keys, "average", "true", "range");

  const rows: ScreenerRow[] = [];
  const seen = new Set<string>();
  for (const row of data) {
    const t = (row[tickerCol] ?? "").trim().toUpperCase();
    if (!t || seen.has(t)) continue;
    seen.add(t);

    const price = priceCol ? (row[priceCol] || getVal(row, "Price", "price")) : getVal(row, "Price", "price");
    const change = changeCol ? (row[changeCol] || getVal(row, "Change", "change")) : getVal(row, "Change", "change");
    const vol = volCol ? (row[volCol] || getVal(row, "Volume", "volume")) : getVal(row, "Volume", "volume");
    const avgVol = avgVolCol ? (row[avgVolCol] || getVal(row, "Avg Volume", "Average Volume")) : getVal(row, "Avg Volume", "Average Volume");
    let relVol = relVolCol ? (row[relVolCol] || getVal(row, "Rel Volume", "Relative Volume")) : getVal(row, "Rel Volume", "Relative Volume");

    // Compute relative volume if missing
    if (!relVol && vol && avgVol) {
      const vNum = parseNum(vol);
      const aNum = parseNum(avgVol);
      if (vNum && aNum && aNum !== 0) {
        relVol = (vNum / aNum).toFixed(2);
      }
    }

    const atrRaw = atrCol ? parseNum(row[atrCol] || getVal(row, "ATR", "atr")) : null;
    const priceNum = parseNum(price);
    const atrPct = atrRaw && priceNum && priceNum !== 0
      ? Math.round((atrRaw / priceNum) * 10000) / 100
      : null;

    rows.push({
      ticker: t,
      price,
      change,
      volume: vol,
      avg_vol: avgVol,
      rel_vol: relVol,
      atr_pct: atrPct,
    });
  }

  if (rows.length) putCache(cacheKey, rows);
  return rows;
}

// ─── O'Neil screener (ROE + margin filtering) ────────────────────────────────

async function fetchOneilFromUrl(cacheKey: string): Promise<ScreenerRow[]> {
  const cached = getCached(cacheKey);
  if (cached) return cached;

  if (!isEliteConfigured()) return [];
  const url = FINVIZ_EXPORT_URLS.oneil;
  if (!url) return [];

  const data = await fetchExportFromUrl(url, "oneil");
  if (!data.length) return [];

  const keys = Object.keys(data[0]);
  const roeCol = findCol(keys, "roe") ?? findCol(keys, "return", "equity");
  const marginCol = findCol(keys, "net", "margin") ?? findCol(keys, "profit", "margin");

  const rows: ScreenerRow[] = [];
  for (const row of data) {
    const t = getVal(row, "Ticker", "ticker").trim().toUpperCase();
    if (!t) continue;

    const roeV = parsePctVal(roeCol ? row[roeCol] : getVal(row, "ROE", "roe"));
    const marginV = parsePctVal(marginCol ? row[marginCol] : getVal(row, "Net Profit Margin", "Profit Margin"));

    // Filter: combined ROE + margin must be >= 25
    if ((roeV ?? 0) + (marginV ?? 0) < 25) continue;

    const price = getVal(row, "Price", "price");
    const change = getVal(row, "Change", "change");
    const vol = getVal(row, "Volume", "volume");
    const avgVol = getVal(row, "Avg Volume", "Average Volume");
    const relVol = getVal(row, "Rel Volume", "Relative Volume");
    const atrRaw = parseNum(getVal(row, "ATR", "atr"));
    const priceNum = parseNum(price);
    const atrPct = atrRaw && priceNum && priceNum !== 0
      ? Math.round((atrRaw / priceNum) * 10000) / 100
      : null;

    rows.push({
      ticker: t,
      price,
      change,
      volume: vol,
      avg_vol: avgVol,
      rel_vol: relVol,
      atr_pct: atrPct,
      roe: roeV,
      net_margin: marginV,
    });
  }

  if (rows.length) putCache(cacheKey, rows);
  return rows;
}

// ─── Qullamaggie sub-screeners ────────────────────────────────────────────────

async function episodicPivotScreener(): Promise<ScreenerRow[]> {
  const rows = await fetchScreenerFromUrl("qulla_episodic", "screener_ep");
  for (const r of rows) r.tag = "EP";
  return rows;
}

async function parabolicShortScreener(): Promise<ScreenerRow[]> {
  const cached = getCached("screener_ps");
  if (cached) return cached;

  const psLarge = await fetchScreenerFromUrl("qulla_ps_large", "screener_ps_large");
  const psSmall = await fetchScreenerFromUrl("qulla_ps_small", "screener_ps_small");

  const seen = new Set<string>();
  const merged: ScreenerRow[] = [];
  for (const r of [...psLarge, ...psSmall]) {
    if (!seen.has(r.ticker)) {
      seen.add(r.ticker);
      r.tag = "PS";
      merged.push(r);
    }
  }

  if (merged.length) putCache("screener_ps", merged);
  return merged;
}

async function breakoutsScreener(): Promise<ScreenerRow[]> {
  const rows = await fetchScreenerFromUrl("qulla_breakouts", "screener_bo");
  for (const r of rows) r.tag = "BO";
  return rows;
}

async function qullamaggieScreener(): Promise<ScreenerRow[]> {
  const cached = getCached("screener_qulla");
  if (cached) return cached;

  const ep = await episodicPivotScreener();
  const ps = await parabolicShortScreener();
  const bo = await breakoutsScreener();

  const seen = new Map<string, ScreenerRow>();
  for (const r of [...ep, ...ps, ...bo]) {
    if (seen.has(r.ticker)) {
      const existing = seen.get(r.ticker)!;
      const existingTag = existing.tag ?? "";
      const newTag = r.tag ?? "";
      if (newTag && !existingTag.includes(newTag)) {
        existing.tag = existingTag ? `${existingTag},${newTag}` : newTag;
      }
    } else {
      seen.set(r.ticker, { ...r });
    }
  }

  const result = Array.from(seen.values());
  if (result.length) putCache("screener_qulla", result);
  return result;
}

async function minerviniScreener(): Promise<ScreenerRow[]> {
  return fetchScreenerFromUrl("minervini", "screener_minervini");
}

async function oneilScreener(): Promise<ScreenerRow[]> {
  return fetchOneilFromUrl("screener_oneil");
}

// ─── Public dispatch ──────────────────────────────────────────────────────────

export type ScreenerType = "qullamaggie" | "minervini" | "oneil";

const dispatch: Record<ScreenerType, () => Promise<ScreenerRow[]>> = {
  qullamaggie: qullamaggieScreener,
  minervini: minerviniScreener,
  oneil: oneilScreener,
};

export async function runScreener(
  type: ScreenerType,
  force = false,
): Promise<ScreenerRow[]> {
  // Clear relevant cache on force refresh
  if (force) {
    const keysToDelete: string[] = [];
    if (type === "qullamaggie") {
      keysToDelete.push("screener_qulla", "screener_ep", "screener_ps", "screener_ps_large", "screener_ps_small", "screener_bo");
    } else if (type === "minervini") {
      keysToDelete.push("screener_minervini");
    } else if (type === "oneil") {
      keysToDelete.push("screener_oneil");
    }
    for (const k of keysToDelete) cache.delete(k);
  }

  const fn = dispatch[type] ?? qullamaggieScreener;
  return fn();
}
