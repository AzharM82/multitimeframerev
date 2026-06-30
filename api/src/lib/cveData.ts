/**
 * CVE data ingestion.
 *
 * Assembles the day's "stocks in play" universe and attaches recent news to
 * each, ready for the CVE engine. Sources (all degrade gracefully to empty):
 *
 *   Universe:
 *     • FinViz Elite gap screeners (ta_gap_u10 / ta_gap_d10) — robust pre-open,
 *       surfaces pre-market gappers before Polygon's intraday movers populate.
 *     • Polygon gainers / losers snapshot — robust intraday.
 *     • Tickers mentioned in the last ~24h of Polygon market-wide news — fresh
 *       catalysts that may not be top movers yet.
 *
 *   Per-ticker news:
 *     • Polygon /v2/reference/news?ticker= (primary) — includes per-ticker
 *       `insights.sentiment` + reasoning used by the CVE scorer & commentary.
 *     • FinViz market news headlines merged in as a fallback when Polygon is thin.
 *
 * Quotes (change% / price / volume) always come from the Polygon snapshot so
 * every candidate is measured the same way regardless of how it was discovered.
 */

import type { CveCandidate, NewsItem, Direction } from "./cve.js";
import { fetchExportFromUrl, isEliteConfigured } from "./finvizElite.js";

const BASE = "https://api.polygon.io";

function key(): string {
  const k = process.env.POLYGON_API_KEY;
  if (!k) throw new Error("POLYGON_API_KEY not set");
  return k;
}

// ─── Polygon snapshot quote ──────────────────────────────────────────────────

export interface Quote {
  ticker: string;
  price: number;
  changePct: number;
  volume: number;
}

interface SnapTicker {
  ticker?: string;
  lastTrade?: { p?: number };
  day?: { c?: number; v?: number };
  prevDay?: { c?: number; v?: number };
  min?: { c?: number; v?: number; av?: number };
  todaysChangePerc?: number;
}

function toQuote(t: SnapTicker): Quote | null {
  if (!t.ticker) return null;
  const price = t.lastTrade?.p || t.min?.c || t.day?.c || t.prevDay?.c;
  if (!price || price <= 0) return null;
  const prevClose = t.prevDay?.c;
  const changePct =
    t.todaysChangePerc != null
      ? t.todaysChangePerc
      : prevClose
        ? (price / prevClose - 1) * 100
        : 0;
  const volume = t.day?.v || t.min?.av || t.prevDay?.v || 0;
  return { ticker: t.ticker, price, changePct, volume };
}

/** Batched snapshot for a specific ticker list (Polygon caps `tickers` at 250). */
export async function fetchQuotes(tickers: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  const uniq = [...new Set(tickers)];
  for (let i = 0; i < uniq.length; i += 250) {
    const slice = uniq.slice(i, i + 250);
    const url = `${BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${slice.join(",")}&apiKey=${key()}`;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = (await res.json()) as { tickers?: SnapTicker[] };
      for (const t of data.tickers ?? []) {
        const q = toQuote(t);
        if (q) out.set(q.ticker, q);
      }
    } catch {
      // skip chunk
    }
  }
  return out;
}

/** Polygon top gainers / losers (intraday). Empty pre-open and on weekends. */
async function fetchPolygonMovers(): Promise<Quote[]> {
  const out: Quote[] = [];
  for (const dir of ["gainers", "losers"] as const) {
    try {
      const url = `${BASE}/v2/snapshot/locale/us/markets/stocks/${dir}?apiKey=${key()}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = (await res.json()) as { tickers?: SnapTicker[] };
      for (const t of data.tickers ?? []) {
        const q = toQuote(t);
        if (q) out.push(q);
      }
    } catch {
      // skip
    }
  }
  return out;
}

// ─── News ────────────────────────────────────────────────────────────────────

interface PolyNews {
  title?: string;
  description?: string;
  article_url?: string;
  published_utc?: string;
  publisher?: { name?: string };
  tickers?: string[];
  insights?: Array<{ ticker?: string; sentiment?: string; sentiment_reasoning?: string }>;
}

function mapPolyNews(n: PolyNews, ticker: string): NewsItem {
  const insight = (n.insights ?? []).find((i) => i.ticker === ticker);
  const s = insight?.sentiment;
  return {
    title: n.title ?? "",
    description: n.description ?? "",
    url: n.article_url ?? "",
    publishedUtc: n.published_utc ?? "",
    publisher: n.publisher?.name,
    sentiment:
      s === "positive" || s === "negative" || s === "neutral" ? s : undefined,
    sentimentReasoning: insight?.sentiment_reasoning,
  };
}

/** Per-ticker news from Polygon, freshest first. */
export async function fetchTickerNews(ticker: string, limit = 10): Promise<NewsItem[]> {
  try {
    const url = `${BASE}/v2/reference/news?ticker=${ticker}&order=desc&limit=${limit}&apiKey=${key()}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: PolyNews[] };
    return (data.results ?? []).map((n) => mapPolyNews(n, ticker));
  } catch {
    return [];
  }
}

/** Market-wide recent news → tickers in play + a headline map for fallback. */
async function fetchMarketNews(
  hours: number,
  limit = 200,
): Promise<{ tickers: Set<string>; byTicker: Map<string, NewsItem[]> }> {
  const tickers = new Set<string>();
  const byTicker = new Map<string, NewsItem[]>();
  try {
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const url = `${BASE}/v2/reference/news?order=desc&limit=${limit}&published_utc.gte=${since}&apiKey=${key()}`;
    const res = await fetch(url);
    if (!res.ok) return { tickers, byTicker };
    const data = (await res.json()) as { results?: PolyNews[] };
    for (const n of data.results ?? []) {
      for (const t of n.tickers ?? []) {
        if (!/^[A-Z]{1,5}$/.test(t)) continue; // skip crypto/forex pseudo-tickers
        tickers.add(t);
        const item = mapPolyNews(n, t);
        const arr = byTicker.get(t) ?? [];
        if (arr.length < 10) arr.push(item);
        byTicker.set(t, arr);
      }
    }
  } catch {
    // ignore
  }
  return { tickers, byTicker };
}

// ─── FinViz gap screeners (pre-market universe) ──────────────────────────────

// v=152 export, columns: 1=Ticker. Filters: US large-enough liquid names that
// gapped ≥10% up / down. o=-change sorts by today's change.
const FV_FILTER = "geo_usa,sh_avgvol_o500,sh_price_o3";
const FV_GAP_UP = `https://elite.finviz.com/export?v=152&f=${FV_FILTER},ta_gap_u10&o=-change&c=1`;
const FV_GAP_DOWN = `https://elite.finviz.com/export?v=152&f=${FV_FILTER},ta_gap_d10&o=change&c=1`;

async function fetchFinvizGappers(): Promise<string[]> {
  if (!isEliteConfigured()) return [];
  const tickers: string[] = [];
  for (const url of [FV_GAP_UP, FV_GAP_DOWN]) {
    const rows = await fetchExportFromUrl(url, "cve-gap");
    for (const r of rows) {
      const t = (r["Ticker"] ?? r["ticker"] ?? "").trim().toUpperCase();
      if (/^[A-Z]{1,5}$/.test(t)) tickers.push(t);
    }
  }
  return tickers;
}

// ─── Universe assembly ───────────────────────────────────────────────────────

export interface UniverseOptions {
  /** Min |change%| for a name to count as "in play" once quoted. */
  minAbsChange?: number;
  /** Min share price. */
  minPrice?: number;
  /** Min day volume. */
  minVolume?: number;
  /** Cap on tickers we fetch per-ticker news for (keeps within the timeout). */
  maxCandidates?: number;
  /** Lookback window for market-news ticker discovery. */
  newsHours?: number;
}

const DEFAULTS: Required<UniverseOptions> = {
  minAbsChange: 3,
  minPrice: 3,
  minVolume: 200_000,
  maxCandidates: 40,
  newsHours: 24,
};

export interface CveUniverse {
  candidates: CveCandidate[];
  discovered: number;
  sources: { finviz: number; polygonMovers: number; news: number };
  asOf: string;
}

/**
 * Build the in-play universe and attach news to each candidate. Returns the
 * candidates ranked by |change%| (most in-play first), capped at maxCandidates.
 */
export async function buildUniverse(opts: UniverseOptions = {}): Promise<CveUniverse> {
  const o = { ...DEFAULTS, ...opts };

  const [finvizTickers, polyMovers, market] = await Promise.all([
    fetchFinvizGappers(),
    fetchPolygonMovers(),
    fetchMarketNews(o.newsHours),
  ]);

  const all = new Set<string>([
    ...finvizTickers,
    ...polyMovers.map((q) => q.ticker),
    ...market.tickers,
  ]);

  // Authoritative quotes for everything discovered.
  const quotes = await fetchQuotes([...all]);

  // Keep names that are genuinely in play (price/volume floor + a real move),
  // ranked by magnitude of the move.
  const inPlay = [...quotes.values()]
    .filter(
      (q) =>
        q.price >= o.minPrice &&
        q.volume >= o.minVolume &&
        Math.abs(q.changePct) >= o.minAbsChange,
    )
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, o.maxCandidates);

  // Attach news: Polygon per-ticker (primary), market-news fallback if empty.
  const candidates: CveCandidate[] = [];
  for (const q of inPlay) {
    let news = await fetchTickerNews(q.ticker);
    if (news.length === 0) news = market.byTicker.get(q.ticker) ?? [];
    const direction: Direction = q.changePct >= 0 ? "positive" : "negative";
    candidates.push({
      ticker: q.ticker,
      direction,
      changePct: q.changePct,
      price: q.price,
      volume: q.volume,
      news,
    });
  }

  return {
    candidates,
    discovered: all.size,
    sources: {
      finviz: finvizTickers.length,
      polygonMovers: polyMovers.length,
      news: market.tickers.size,
    },
    asOf: new Date().toISOString(),
  };
}
