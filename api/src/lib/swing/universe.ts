/**
 * Swing Strength — the universe.
 *
 * A FIXED list of stocks the operator maintains by hand (a FinViz screener
 * export), not a scanner result. Nothing is added or removed automatically:
 * the list changes only when a new export is uploaded, and every lens on the
 * tab is computed for exactly these names.
 *
 * Parsing is deliberately tolerant of FinViz's export drift: columns are
 * looked up by header NAME, extra columns are carried through as a small
 * "extras" bag, and a row without a ticker is skipped rather than failing the
 * whole upload.
 */

export interface UniverseRow {
  ticker: string;
  company: string;
  sector: string;
  industry: string;
  /** FinViz exports market cap in bare MILLIONS. */
  marketCapM: number | null;
  /** Any other numeric FinViz columns, by their header name (e.g. "Short Interest"). */
  extras: Record<string, number>;
}

/** Minimal RFC-4180 reader: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const t = s.trim().replace(/[%,$]/g, "");
  if (!t || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** Columns that are identity, not metrics, and never go into `extras`. */
const IDENTITY = new Set(["No.", "Ticker", "Company", "Sector", "Industry", "Market Cap", "Country"]);

export function parseFinvizExport(text: string): { rows: UniverseRow[]; skipped: number; columns: string[] } {
  const table = parseCsv(text);
  if (table.length < 2) return { rows: [], skipped: 0, columns: [] };
  const header = table[0].map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const iT = col("Ticker"), iCo = col("Company"), iS = col("Sector"), iI = col("Industry"), iM = col("Market Cap");
  if (iT < 0) throw new Error('Not a FinViz export: no "Ticker" column');

  const rows: UniverseRow[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const r of table.slice(1)) {
    const ticker = (r[iT] ?? "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) || seen.has(ticker)) { skipped++; continue; }
    seen.add(ticker);
    const extras: Record<string, number> = {};
    header.forEach((h, i) => {
      if (IDENTITY.has(h) || !h) return;
      const v = num(r[i]);
      if (v !== null) extras[h] = v;
    });
    rows.push({
      ticker,
      company: (iCo >= 0 ? r[iCo] : "")?.trim() ?? "",
      sector: (iS >= 0 ? r[iS] : "")?.trim() ?? "",
      industry: (iI >= 0 ? r[iI] : "")?.trim() ?? "",
      marketCapM: iM >= 0 ? num(r[iM]) : null,
      extras,
    });
  }
  return { rows, skipped, columns: header };
}
