/**
 * Bars for the shadow ledger, from Alpaca's free Basic plan.
 *
 * Everything here is fetched AFTER the close, so the 15-minute delay on the
 * Basic plan never matters:
 *   • SPY 1-minute and 2-minute bars from the SIP feed (consolidated tape —
 *     the IEX feed the Opening Drive engine uses is fine for its ratio but
 *     would put the EMA on partial prices);
 *   • option 1-minute bars from the indicative feed, which is what the free
 *     plan serves for OPRA-derived bars.
 *
 * Verified 2026-09-05 with the production keys: both endpoints return full
 * sessions for past days on this plan.
 */

import type { MinuteBar } from "./rule.js";

const DATA_BASE = "https://data.alpaca.markets";

function headers(): Record<string, string> {
  const key = process.env.ALPACA_API_KEY || process.env.APCA_API_KEY_ID || "";
  const secret = process.env.ALPACA_API_SECRET || process.env.APCA_API_SECRET_KEY || "";
  if (!key || !secret) throw new Error("Alpaca credentials not set (ALPACA_API_KEY / ALPACA_API_SECRET)");
  return { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };
}

interface RawBar { t: string; o: number; h: number; l: number; c: number; v: number; vw?: number }

/** Regular session in UTC for an ET day: a generous 13:00–21:00 window; the
 *  rule only looks at bars after the alert, and EOD is the last printed bar,
 *  so we clip to the cash session ourselves. */
function sessionBounds(day: string): { start: string; end: string } {
  return { start: `${day}T13:25:00Z`, end: `${day}T20:05:00Z` };
}

async function paged(url: string, params: URLSearchParams, pick: (d: unknown) => RawBar[]): Promise<MinuteBar[]> {
  const out: MinuteBar[] = [];
  let token: string | undefined;
  for (let page = 0; page < 20; page++) {
    if (token) params.set("page_token", token);
    let res: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(`${url}?${params.toString()}`, { headers: headers() });
      if (res.status !== 429) break;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    if (!res || !res.ok) {
      const text = res ? await res.text() : "";
      throw new Error(`Alpaca ${res?.status ?? "?"} ${url.split("/").slice(-2).join("/")}: ${text.slice(0, 160)}`);
    }
    const data = (await res.json()) as { next_page_token?: string | null };
    out.push(...pick(data));
    token = data.next_page_token ?? undefined;
    if (!token) break;
  }
  out.sort((a, b) => a.t.localeCompare(b.t));
  return out;
}

/** SPY bars for one ET day, cash session only. `timeframe` is "1Min" or "2Min". */
export async function fetchSpyBars(day: string, timeframe: "1Min" | "2Min"): Promise<MinuteBar[]> {
  const { start, end } = sessionBounds(day);
  const params = new URLSearchParams({ timeframe, start, end, feed: "sip", adjustment: "raw", limit: "10000", sort: "asc" });
  const bars = await paged(`${DATA_BASE}/v2/stocks/SPY/bars`, params, (d) => ((d as { bars?: RawBar[] }).bars ?? []));
  return clipToSession(bars, day);
}

/** 1-minute bars for one OCC option symbol on one ET day, cash session only. */
export async function fetchOptionBars(symbol: string, day: string): Promise<MinuteBar[]> {
  const { start, end } = sessionBounds(day);
  const params = new URLSearchParams({ symbols: symbol, timeframe: "1Min", start, end, limit: "10000", sort: "asc" });
  const bars = await paged(`${DATA_BASE}/v1beta1/options/bars`, params,
    (d) => ((d as { bars?: Record<string, RawBar[]> }).bars?.[symbol] ?? []));
  return clipToSession(bars, day);
}

/** Keep 09:30:00–15:59:59 ET. Done by wall clock so DST is handled once. */
function clipToSession(bars: RawBar[], day: string): MinuteBar[] {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
  return bars
    .filter((b) => {
      const hhmm = fmt.format(new Date(b.t));
      return hhmm >= "09:30" && hhmm <= "15:59" && b.t.startsWith(day);
    })
    .map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, vw: b.vw }));
}
