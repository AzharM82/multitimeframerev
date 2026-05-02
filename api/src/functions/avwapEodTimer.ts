import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { fetchDailyBarsExtended } from "../lib/polygon.js";
import { scanAvwap, type AvwapHit } from "../lib/avwap.js";
import { getCapitulationTickers } from "../lib/capitulationTickers.js";
import { upsert, TABLES } from "../lib/tables.js";
import { sendHtmlEmail } from "../lib/email.js";

const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 500;
const TOP_N = 30;

function todayKey(): string {
  return new Date().toISOString().split("T")[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function scanOne(ticker: string): Promise<AvwapHit[]> {
  try {
    const bars = await fetchDailyBarsExtended(ticker, 5);
    if (bars.length < 60) return [];
    return scanAvwap(ticker, bars);
  } catch {
    return [];
  }
}

async function runEodScan(ctx: InvocationContext): Promise<AvwapHit[]> {
  const tickers = await getCapitulationTickers();
  ctx.log(`AVWAP EOD scan: ${tickers.length} tickers`);

  const allHits: AvwapHit[] = [];
  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(scanOne));
    for (const hits of results) allHits.push(...hits);
    if (i + BATCH_SIZE < tickers.length) await sleep(BATCH_DELAY_MS);
  }

  allHits.sort((a, b) => b.score - a.score);
  return allHits;
}

function renderEmail(hits: AvwapHit[]): string {
  const top = hits.slice(0, TOP_N);
  const date = todayKey();

  const rows = top
    .map((h, i) => {
      const anchors = h.involvedAnchors.join(", ");
      const tvUrl = `https://www.tradingview.com/chart/?symbol=${h.ticker}`;
      const trendBadge = h.trendAligned
        ? `<span style="background:#22c55e;color:#fff;padding:2px 6px;border-radius:3px;font-size:11px">UP</span>`
        : `<span style="background:#94a3b8;color:#fff;padding:2px 6px;border-radius:3px;font-size:11px">—</span>`;
      return `
      <tr style="border-bottom:1px solid #e2e8f0">
        <td style="padding:8px;color:#64748b;font-size:12px">${i + 1}</td>
        <td style="padding:8px"><a href="${tvUrl}" style="color:#0ea5e9;text-decoration:none;font-weight:600">${h.ticker}</a></td>
        <td style="padding:8px;font-weight:600">${h.pattern}</td>
        <td style="padding:8px;text-align:right;font-weight:700;color:#0ea5e9">${h.score}</td>
        <td style="padding:8px;text-align:right">$${h.price.toFixed(2)}</td>
        <td style="padding:8px;font-size:12px;color:#475569">${anchors}</td>
        <td style="padding:8px;text-align:right;font-size:12px">${h.bandPct.toFixed(2)}%</td>
        <td style="padding:8px;text-align:right;font-size:12px">${h.volumeMultiple.toFixed(2)}×</td>
        <td style="padding:8px;text-align:center">${trendBadge}</td>
      </tr>`;
    })
    .join("");

  const counts = top.reduce<Record<string, number>>((acc, h) => {
    acc[h.pattern] = (acc[h.pattern] || 0) + 1;
    return acc;
  }, {});

  return `
<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;margin:0;padding:24px">
  <div style="max-width:900px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0">
    <div style="background:#0f172a;color:#f8fafc;padding:20px 24px">
      <div style="font-size:11px;letter-spacing:2px;color:#94a3b8;text-transform:uppercase">Brian Shannon · Anchored VWAP</div>
      <h1 style="margin:6px 0 0;font-size:24px;font-weight:700">Swing Setups · ${date}</h1>
      <div style="margin-top:8px;color:#cbd5e1;font-size:13px">
        ${hits.length} total hits · Showing top ${top.length} ·
        Pullback: <b>${counts.PULLBACK || 0}</b> ·
        Pinch: <b>${counts.PINCH || 0}</b> ·
        Reclaim: <b>${counts.RECLAIM || 0}</b>
      </div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="background:#f1f5f9;text-align:left">
          <th style="padding:10px 8px;font-size:11px;text-transform:uppercase;color:#64748b">#</th>
          <th style="padding:10px 8px;font-size:11px;text-transform:uppercase;color:#64748b">Ticker</th>
          <th style="padding:10px 8px;font-size:11px;text-transform:uppercase;color:#64748b">Pattern</th>
          <th style="padding:10px 8px;font-size:11px;text-transform:uppercase;color:#64748b;text-align:right">Score</th>
          <th style="padding:10px 8px;font-size:11px;text-transform:uppercase;color:#64748b;text-align:right">Price</th>
          <th style="padding:10px 8px;font-size:11px;text-transform:uppercase;color:#64748b">Anchors</th>
          <th style="padding:10px 8px;font-size:11px;text-transform:uppercase;color:#64748b;text-align:right">Band</th>
          <th style="padding:10px 8px;font-size:11px;text-transform:uppercase;color:#64748b;text-align:right">Vol</th>
          <th style="padding:10px 8px;font-size:11px;text-transform:uppercase;color:#64748b;text-align:center">Trend</th>
        </tr>
      </thead>
      <tbody>
        ${rows || `<tr><td colspan="9" style="padding:24px;text-align:center;color:#64748b">No setups today.</td></tr>`}
      </tbody>
    </table>
    <div style="padding:14px 24px;background:#f8fafc;color:#64748b;font-size:11px;border-top:1px solid #e2e8f0">
      Anchors: ATH · 52W High · 52W Low · YTD · Swing Low. Earnings anchors deferred for v1.
      &nbsp;·&nbsp; Generated by MTF Reversal AVWAP Scanner
    </div>
  </div>
</body>
</html>`;
}

async function persistResults(date: string, hits: AvwapHit[]): Promise<void> {
  await upsert(TABLES.AVWAP_RESULTS, date, "summary", {
    date,
    totalHits: hits.length,
    payload: JSON.stringify(hits.slice(0, 100)),
    updatedAt: new Date().toISOString(),
  });
}

async function avwapEodHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const secret = req.headers.get("x-timer-secret");
  if (!process.env.TIMER_SECRET || secret !== process.env.TIMER_SECRET) {
    return { status: 401, jsonBody: { error: "Unauthorized" } };
  }

  try {
    const date = todayKey();
    const hits = await runEodScan(ctx);
    await persistResults(date, hits);

    const reportTo = process.env.REPORT_TO_EMAIL;
    let emailStatus: string;
    if (reportTo && process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
      const html = renderEmail(hits);
      await sendHtmlEmail(reportTo, `AVWAP Swing Report · ${date} · ${hits.length} hits`, html);
      emailStatus = `sent to ${reportTo}`;
    } else {
      emailStatus = "skipped (no REPORT_TO_EMAIL or Gmail creds)";
    }

    return {
      jsonBody: {
        status: "ok",
        date,
        totalHits: hits.length,
        topN: Math.min(TOP_N, hits.length),
        email: emailStatus,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    ctx.error(`avwapEodTimer error: ${message}`);
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("avwapEodTimer", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "avwap-eod-timer",
  handler: avwapEodHandler,
});
