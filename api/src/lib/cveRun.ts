/**
 * CVE run orchestration + snapshot persistence.
 *
 * Ties the data layer (buildUniverse) to the engine (evaluate), ranks the
 * tradeable (B/A/A+) results into top-3 bullish / top-3 bearish, and stores the
 * snapshot under the fixed "latest" partition (gzip + chunked, same as ATR).
 */

import { gzipSync, gunzipSync } from "zlib";
import { buildUniverse, type UniverseOptions } from "./cveData.js";
import { evaluate, isTradeable, type CveResult, type Grade } from "./cve.js";
import { upsert, getOne, TABLES } from "./tables.js";
import { pacificDateKey } from "./dates.js";

export type Phase = "open" | "close" | "manual";

export interface CveSnapshot {
  generated: string;
  asOf: string;
  phase: Phase;
  positives: CveResult[];   // top 3 tradeable bullish
  negatives: CveResult[];   // top 3 tradeable bearish
  tradeable: CveResult[];   // all B/A/A+ both directions (for the table)
  scanned: number;          // candidates evaluated
  discovered: number;       // tickers discovered before filtering
  sources: { finviz: number; polygonMovers: number; news: number };
}

const GRADE_RANK: Record<Grade, number> = { "A+": 5, A: 4, B: 3, C: 2, D: 1 };

/** Best first: grade, then numeric CVE, then magnitude of the move. */
function rank(a: CveResult, b: CveResult): number {
  if (GRADE_RANK[b.grade] !== GRADE_RANK[a.grade]) return GRADE_RANK[b.grade] - GRADE_RANK[a.grade];
  if (b.cve !== a.cve) return b.cve - a.cve;
  return Math.abs(b.changePct) - Math.abs(a.changePct);
}

export async function runCve(phase: Phase, opts: UniverseOptions = {}): Promise<CveSnapshot> {
  const universe = await buildUniverse(opts);
  const results = universe.candidates.map(evaluate);

  const tradeable = results.filter((r) => isTradeable(r.grade)).sort(rank);
  const positives = tradeable.filter((r) => r.direction === "positive").slice(0, 3);
  const negatives = tradeable.filter((r) => r.direction === "negative").slice(0, 3);

  return {
    generated: new Date().toISOString(),
    asOf: pacificDateKey(),
    phase,
    positives,
    negatives,
    tradeable,
    scanned: universe.candidates.length,
    discovered: universe.discovered,
    sources: universe.sources,
  };
}

// ─── persistence (gzip + ≤32K-char chunks under the 64KB Table column cap) ────

const CHUNK_CHARS = 30000;

interface CveRow {
  generated: string;
  asOf: string;
  phase: Phase;
  scanned: number;
  discovered: number;
  parts: number;
  [chunk: string]: unknown;
}

export async function persistSnapshot(snap: CveSnapshot): Promise<void> {
  const payload = {
    positives: snap.positives,
    negatives: snap.negatives,
    tradeable: snap.tradeable,
    sources: snap.sources,
  };
  const b64 = gzipSync(Buffer.from(JSON.stringify(payload))).toString("base64");
  const chunks: Record<string, string> = {};
  let parts = 0;
  for (let i = 0; i < b64.length; i += CHUNK_CHARS) {
    chunks[`p${parts}`] = b64.slice(i, i + CHUNK_CHARS);
    parts++;
  }
  await upsert(TABLES.CVE_EVAL, "latest", "snapshot", {
    generated: snap.generated,
    asOf: snap.asOf,
    phase: snap.phase,
    scanned: snap.scanned,
    discovered: snap.discovered,
    parts,
    ...chunks,
  });
}

export async function loadSnapshot(): Promise<CveSnapshot | null> {
  const row = await getOne<CveRow>(TABLES.CVE_EVAL, "latest", "snapshot");
  if (!row) return null;
  let b64 = "";
  for (let i = 0; i < (row.parts ?? 0); i++) b64 += (row[`p${i}`] as string) ?? "";
  const payload = b64
    ? (JSON.parse(gunzipSync(Buffer.from(b64, "base64")).toString("utf-8")) as {
        positives: CveResult[];
        negatives: CveResult[];
        tradeable: CveResult[];
        sources: CveSnapshot["sources"];
      })
    : { positives: [], negatives: [], tradeable: [], sources: { finviz: 0, polygonMovers: 0, news: 0 } };
  return {
    generated: row.generated,
    asOf: row.asOf,
    phase: row.phase,
    scanned: row.scanned,
    discovered: row.discovered,
    ...payload,
  };
}
