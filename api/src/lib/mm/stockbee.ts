/**
 * Stockbee Market Monitor breadth, ported from MarketMetrics
 * `api/shared/stockbee.py` (breadth half only — the Momentum 50 sheet is out of
 * scope for this port).
 *
 * The sheet is read through Google's gviz endpoint, which answers with JSONP:
 * `google.visualization.Query.setResponse({...});`. TLS verification is NOT
 * disabled here (the Python used `ssl.CERT_NONE`).
 */

import { MARKET_BREADTH_SHEET_URL } from "./constants.js";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

export type GvizCellValue = string | number | boolean | null;

interface GvizCell {
  v?: GvizCellValue;
  f?: string;
}

interface GvizRow {
  c?: (GvizCell | null)[];
}

interface GvizCol {
  label?: string;
}

interface GvizPayload {
  table?: {
    cols?: GvizCol[];
    rows?: GvizRow[];
  };
}

export interface BreadthRow {
  date: string | null;
  up4: GvizCellValue;
  down4: GvizCellValue;
  ratio5: GvizCellValue;
  ratio10: GvizCellValue;
  t2108: GvizCellValue;
  sp500: GvizCellValue;
}

/**
 * Fetch a gviz sheet and unwrap the JSONP envelope.
 *
 * Source: `stockbee.py:_fetch_gviz`. The unwrap is the same greedy
 * `/\{.*\}/s` match as the Python `re.search(r"\{.*\}", text, re.DOTALL)` —
 * first `{` through last `}` — rather than a strict prefix/suffix strip, so it
 * survives Google changing the callback name or adding a trailing newline.
 */
export async function fetchGviz(url: string): Promise<GvizPayload | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
    const text = (await res.text()).trim();
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) {
      console.warn("gviz: no JSON found in response");
      return null;
    }
    return JSON.parse(match[0]) as GvizPayload;
  } catch (err: unknown) {
    console.warn(`gviz fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Read one gviz cell.
 *
 * Source: `stockbee.py:_extract_cell_value`. gviz serialises dates as the string
 * `Date(year, month, day)` with a **0-based month**, so the month is bumped by
 * one and the cell is rendered as `M/D/YYYY`. Anything else returns `v`, or `f`
 * (the formatted value) when `v` is absent.
 */
export function extractCellValue(cell: GvizCell | null | undefined): GvizCellValue {
  if (cell === null || cell === undefined) return null;

  const v = cell.v;
  const f = cell.f;

  if (v !== null && v !== undefined) {
    if (typeof v === "string" && v.startsWith("Date(")) {
      const m = /^Date\((\d+),\s*(\d+),\s*(\d+)\)/.exec(v);
      if (m) {
        const yr = Number(m[1]);
        const mo = Number(m[2]) + 1;
        const dy = Number(m[3]);
        return `${mo}/${dy}/${yr}`;
      }
    }
    return v;
  }

  return f ?? null;
}

/**
 * Column resolver from `stockbee.py`: for each candidate name in order, return
 * the first column whose lowercased label *contains* it. The sheet's headers
 * drift ("Ratio 5 day" vs "5day ratio"), hence substring matching.
 */
function makeFindCol(colLabels: string[]) {
  return (...names: string[]): number | null => {
    for (const name of names) {
      const nl = name.toLowerCase();
      for (let i = 0; i < colLabels.length; i += 1) {
        if (colLabels[i].includes(nl)) return i;
      }
    }
    return null;
  };
}

const DATE_IDX = 0;

interface BreadthColumnIndices {
  up4: number | null;
  down4: number | null;
  ratio5: number | null;
  ratio10: number | null;
  t2108: number | null;
  sp500: number | null;
}

function resolveColumns(cols: GvizCol[]): BreadthColumnIndices {
  const colLabels = cols.map((c) => String(c.label ?? "").trim().toLowerCase());
  const findCol = makeFindCol(colLabels);
  return {
    up4: findCol("up4", "up 4", "4% up"),
    down4: findCol("down4", "down 4", "4% down"),
    ratio5: findCol("ratio5", "5 day", "5day"),
    ratio10: findCol("ratio10", "10 day", "10day"),
    t2108: findCol("t2108", "2108"),
    sp500: findCol("sp500", "s&p", "spy"),
  };
}

function readRow(cells: (GvizCell | null)[], idx: BreadthColumnIndices): BreadthRow {
  const cell = (i: number | null): GvizCellValue => {
    if (i === null || i >= cells.length) return null;
    return extractCellValue(cells[i]);
  };
  const dateVal = cell(DATE_IDX);
  return {
    date: dateVal === null ? null : String(dateVal),
    up4: cell(idx.up4),
    down4: cell(idx.down4),
    ratio5: cell(idx.ratio5),
    ratio10: cell(idx.ratio10),
    t2108: cell(idx.t2108),
    sp500: cell(idx.sp500),
  };
}

/**
 * Latest breadth reading.
 *
 * BUG FIX vs the Python original. `stockbee.py:fetch_stockbee_breadth` takes
 * `rows[-1]`, assuming the sheet is oldest-first. It is not — the sheet is
 * sorted NEWEST-FIRST (verified: rows[0] = 7/17/2026, rows[-1] = 12/18/2025),
 * so the original has been reporting a reading seven months stale as "latest".
 * We take rows[0] instead.
 */
export async function fetchStockbeeBreadth(): Promise<BreadthRow | null> {
  const data = await fetchGviz(MARKET_BREADTH_SHEET_URL);
  const cols = data?.table?.cols ?? [];
  const rows = data?.table?.rows ?? [];
  if (cols.length === 0 || rows.length === 0) return null;

  const idx = resolveColumns(cols);
  return readRow(rows[0].c ?? [], idx);
}

/**
 * Most recent `days` rows of breadth history, returned oldest-first for charts.
 *
 * BUG FIX vs the Python original, same root cause as above: it did
 * `rows[-days:]`, which on a newest-first sheet returns the OLDEST rows. We
 * take the first `days` rows (the newest) and reverse them so charts still
 * read left-to-right in time order.
 */
export async function fetchStockbeeBreadthHistory(days = 60): Promise<BreadthRow[]> {
  const data = await fetchGviz(MARKET_BREADTH_SHEET_URL);
  const cols = data?.table?.cols ?? [];
  const rows = data?.table?.rows ?? [];
  if (cols.length === 0 || rows.length === 0) return [];

  const idx = resolveColumns(cols);
  const recent = rows.length > days ? rows.slice(0, days) : rows;

  const history: BreadthRow[] = [];
  for (const row of recent) {
    const parsed = readRow(row.c ?? [], idx);
    if (!parsed.date) continue;
    history.push(parsed);
  }
  // Sheet is newest-first; charts want oldest-first.
  return history.reverse();
}

export interface BreadthPayload {
  latest: BreadthRow | null;
  history: BreadthRow[];
}

/**
 * The shape the `stockbee-breadth` panel consumes.
 * Source: `stockbee.py:compute_breadth_data`. The two fetches hit the same
 * sheet; they are issued in parallel here since neither depends on the other.
 */
export async function computeBreadthData(days = 60): Promise<BreadthPayload> {
  const [latest, history] = await Promise.all([
    fetchStockbeeBreadth(),
    fetchStockbeeBreadthHistory(days),
  ]);
  return { latest, history };
}
