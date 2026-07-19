/**
 * CSV parsing and the fuzzy column matcher, ported from MarketMetrics
 * `api/shared/data_fetcher.py` (`_isnan`, `_parse_pct`, `_parse_num`,
 * `_get_csv_val`, `_find_csv_col`) and `api/shared/finviz_elite.py`
 * (`csv.DictReader` handling in `fetch_export_from_url`).
 *
 * FinViz export headers differ between the `v=111` / `v=141` / `v=152` / `v=161`
 * views — "Perf Week" vs "Performance (Week)", "ATR" vs "ATR (14)" and so on —
 * so every read goes through the fuzzy lookups below rather than a fixed key.
 * The matching rules are ported literally, including the regex in `parseNum`.
 */

export type CsvRow = Record<string, string>;

/**
 * Python `_isnan`: `x is None or (isinstance(x, float) and x != x)`.
 * Widened for TS, where `undefined` is also a "no reading".
 */
export function isMissingNum(x: number | null | undefined): boolean {
  return x === null || x === undefined || Number.isNaN(x);
}

/**
 * `_parse_pct` — strips commas and `%`, returns `NaN` on anything unparseable.
 *
 * Python's `float()` accepts a leading `+`, surrounding whitespace, `inf`/`nan`
 * and underscores; `Number()` accepts hex/binary/octal literals and the empty
 * string instead. The guards below narrow JS back to Python's decimal-float
 * grammar so `""`, `"0x10"` and `"1_0"` all become `NaN`, as they do in Python
 * (`""` and `"0x10"` raise `ValueError`; `"1_0"` is the one intentional
 * divergence and is treated as unparseable).
 */
export function parsePct(s: unknown): number {
  if (s === null || s === undefined) return NaN;
  if (typeof s === "number") return Number.isNaN(s) ? NaN : s;
  const cleaned = String(s).trim().replace(/,/g, "").replace(/%/g, "");
  return pythonFloat(cleaned);
}

/** Decimal-float grammar accepted by Python's `float()` (minus inf/nan/`_`). */
const PY_FLOAT_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function pythonFloat(s: string): number {
  const t = s.trim();
  if (!PY_FLOAT_RE.test(t)) return NaN;
  return Number(t);
}

/**
 * `_parse_num` — strips commas / `$` / `%`, then applies a K/M/B suffix.
 *
 * Ported regex-for-regex: Python uses `re.match(r"([\d.-]+)\s*([KMB])?", s,
 * re.I)`, which is anchored at the start only (no `$`), so trailing junk after
 * the suffix is ignored. The JS equivalent is `/^([\d.-]+)\s*([KMB])?/i`.
 * Note the character class is `[\d.-]+`, not a real number grammar — inputs
 * like `"1.2.3"` reach `float()` and yield `null` here, matching Python's
 * `ValueError` path only insofar as `float()` also fails; Python would in fact
 * raise, so the original crashes there. Returning `null` is the one deliberate
 * hardening.
 */
export function parseNum(s: unknown): number | null {
  if (s === null || s === undefined) return null;
  if (typeof s === "number") return Number.isNaN(s) ? null : s;

  const cleaned = String(s).trim().replace(/,/g, "").replace(/\$/g, "").replace(/%/g, "");
  if (!cleaned || cleaned === "-") return null;

  const m = /^([\d.-]+)\s*([KMB])?/i.exec(cleaned);
  if (!m) {
    const v = pythonFloat(cleaned);
    return Number.isNaN(v) ? null : v;
  }

  const val = pythonFloat(m[1]);
  if (Number.isNaN(val)) return null;

  const suffix = (m[2] ?? "").toUpperCase();
  if (suffix === "K") return val * 1e3;
  if (suffix === "M") return val * 1e6;
  if (suffix === "B") return val * 1e9;
  return val;
}

/**
 * `_get_csv_val` — case-insensitive, whitespace-tolerant lookup across a list of
 * candidate header names. Returns the first candidate whose value is neither
 * blank nor `"-"`, else `""`.
 */
export function getCsvVal(row: Record<string, unknown>, ...candidates: string[]): string {
  const rowLower = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) {
    rowLower.set(String(k).trim().toLowerCase(), v);
  }
  for (const c of candidates) {
    const cl = String(c).trim().toLowerCase();
    if (rowLower.has(cl)) {
      const v = rowLower.get(cl);
      if (v !== null && v !== undefined) {
        const sv = String(v).trim();
        if (sv !== "" && sv !== "-") return String(v);
      }
    }
  }
  return "";
}

/**
 * `_find_csv_col` — resolve a header name from a set of substrings that must ALL
 * appear (case-insensitively) in the header, with an optional exact match tried
 * first. Returns `null` when nothing matches.
 *
 * Python signature is `_find_csv_col(keys, *substrings, exact=None)`; the
 * varargs become an explicit array here.
 */
export function findCsvCol(
  keys: string[],
  substrings: string[] = [],
  exact?: string,
): string | null {
  if (exact) {
    const el = String(exact).toLowerCase();
    for (const k of keys) {
      if (String(k).trim().toLowerCase() === el) return k;
    }
  }
  if (substrings.length === 0) return null;
  for (const k of keys) {
    const kl = String(k).toLowerCase();
    if (substrings.every((s) => kl.includes(s.toLowerCase()))) return k;
  }
  return null;
}

/**
 * Split one CSV line, honouring double-quoted fields and `""` escapes. FinViz
 * news headlines routinely contain commas and quotes, so this cannot be a
 * `split(",")`.
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * Parse a FinViz CSV export into row dicts.
 *
 * Mirrors `finviz_elite.py:fetch_export_from_url`: strips the BOM, bails out if
 * the body is an HTML/login page, and back-fills a `Ticker` key when the export
 * only carries the lowercase `ticker` header.
 */
export function parseCsv(text: string): CsvRow[] {
  const clean = text.trim().replace(/^\uFEFF/, "");
  if (clean.startsWith("<") || /login/i.test(clean.slice(0, 500))) return [];

  const lines = clean
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  const rows: CsvRow[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const values = parseCsvLine(lines[i]);
    const row: CsvRow = {};
    for (let j = 0; j < headers.length; j += 1) {
      row[headers[j]] = values[j] ?? "";
    }
    if (row["ticker"] !== undefined && row["Ticker"] === undefined) {
      row["Ticker"] = row["ticker"];
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Python's `round(x, n)` for the display values in the ported panels.
 *
 * CPython uses banker's rounding (round-half-to-even) while this uses
 * half-away-from-zero. The divergence only shows up on exact `.5` ties at the
 * rounding digit of cosmetic fields (`atr_pct`, `week`, `month`, `pct`), never
 * on a membership decision, all of which are made on unrounded values.
 */
export function round(value: number, digits = 0): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.sign(value) * Math.round(Math.abs(value) * factor) / factor;
}

/** Python `f"{v:+.2f}%"`. */
export function formatSignedPct(value: number | null | undefined): string {
  const v = value === null || value === undefined || Number.isNaN(value) ? 0 : value;
  return `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(2)}%`;
}
