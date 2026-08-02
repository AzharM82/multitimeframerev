/**
 * Alpaca market-data client (free IEX feed).
 *
 * Real-time 2-minute bars for the Opening Drive engine, cloud-only — no local
 * machine. The free IEX feed is real-time (partial volume); Opening Drive keeps
 * everything in IEX space (PMH and RVOL both from IEX) so the partial-volume
 * cancels in the ratio and the live close is compared to an IEX-derived PMH.
 *
 * Alpaca aligns intraday bars to the top of the hour, so `2Min` bars fall on
 * 9:30 / 9:32 / … naturally (30 is even) — the same boundary the replay uses.
 *
 * Auth reuses the user's existing Alpaca keys (DTSWAI paper). Both the Alpaca
 * standard env names and the portal's shorter aliases are accepted.
 */

import type { Bar } from "./openingDrive/trigger.js";

const DATA_BASE = "https://data.alpaca.markets";

function creds(): { key: string; secret: string } {
  const key = process.env.ALPACA_API_KEY || process.env.APCA_API_KEY_ID || "";
  const secret = process.env.ALPACA_API_SECRET || process.env.APCA_API_SECRET_KEY || "";
  return { key, secret };
}

export function isAlpacaConfigured(): boolean {
  const { key, secret } = creds();
  return !!(key && secret);
}

interface AlpacaBar {
  t: string; // RFC3339 bar-open time
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n?: number;
  vw?: number;
}

function toBar(b: AlpacaBar): Bar {
  return {
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v,
    timestamp: new Date(b.t).getTime(),
  };
}

/**
 * IEX bars for many symbols in one call (Alpaca returns a per-symbol map and
 * paginates via next_page_token). `timeframe` is Alpaca syntax, e.g. "2Min",
 * "1Min", "1Day". `start`/`end` are RFC3339 (or YYYY-MM-DD).
 */
export async function fetchIexBars(
  symbols: string[],
  timeframe: string,
  start: string,
  end?: string,
): Promise<Map<string, Bar[]>> {
  const out = new Map<string, Bar[]>();
  const uniq = [...new Set(symbols.map((s) => s.toUpperCase().trim()))].filter(Boolean);
  if (!uniq.length) return out;
  const { key, secret } = creds();
  if (!key || !secret) throw new Error("Alpaca credentials not set (ALPACA_API_KEY / ALPACA_API_SECRET)");

  const headers = { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };

  // Alpaca caps the symbols query modestly; chunk to be safe.
  const CHUNK = 100;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const slice = uniq.slice(i, i + CHUNK);
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        symbols: slice.join(","),
        timeframe,
        start,
        feed: "iex",
        adjustment: "raw",
        limit: "10000",
        sort: "asc",
      });
      if (end) params.set("end", end);
      if (pageToken) params.set("page_token", pageToken);

      const res = await fetch(`${DATA_BASE}/v2/stocks/bars?${params.toString()}`, { headers });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Alpaca bars ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as { bars?: Record<string, AlpacaBar[]>; next_page_token?: string | null };
      for (const [sym, bars] of Object.entries(data.bars ?? {})) {
        const acc = out.get(sym) ?? [];
        acc.push(...bars.map(toBar));
        out.set(sym, acc);
      }
      pageToken = data.next_page_token ?? undefined;
    } while (pageToken);
  }

  // Ensure chronological order per symbol.
  for (const arr of out.values()) arr.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}
