/**
 * CVE notifications — email (Gmail SMTP) + Pushover push.
 *
 * Payload per spec §6: ticker & current move %, catalyst type, the explicit
 * [Magnitude] × [Speed] = [Grade] line, the daily-stop allocation, and a short
 * generated commentary. Only B/A/A+ grades reach here (already filtered).
 */

import { sendHtmlEmail } from "./email.js";
import type { CveResult } from "./cve.js";
import type { CveSnapshot, Phase } from "./cveRun.js";

function phaseLabel(phase: Phase): string {
  if (phase === "open") return "Pre-Open (T-15 min)";
  if (phase === "close") return "Pre-Close (T-15 min)";
  return "Manual Run";
}

// Mirrors the website tab's colour language so the email reads the same way.
const GRADE_COLOR: Record<string, string> = {
  "A+": "#15803d", A: "#16a34a", B: "#ca8a04", C: "#94a3b8", D: "#cbd5e1",
};
const CATALYST_COLOR: Record<string, { bg: string; fg: string }> = {
  Fundamental: { bg: "#e0f2fe", fg: "#0369a1" },
  Technical: { bg: "#ede9fe", fg: "#6d28d9" },
  Combination: { bg: "#fae8ff", fg: "#a21caf" },
  None: { bg: "#f1f5f9", fg: "#64748b" },
};
const RATING_COLOR: Record<string, string> = {
  Absolute: "#15803d", Yes: "#16a34a", Maybe: "#ca8a04", No: "#dc2626",
};

const fmtMove = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
const fmtAge = (h: number | null) =>
  h == null ? "" : h < 1 ? "<1h ago" : h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`;

// ─── email — tabular view that mirrors the website tab ───────────────────────

function ratingSpan(r: string): string {
  return `<span style="color:${RATING_COLOR[r] ?? "#111"};font-weight:bold;">${r}</span>`;
}

function chip(type: string): string {
  const c = CATALYST_COLOR[type] ?? CATALYST_COLOR.None;
  return `<span style="background:${c.bg};color:${c.fg};padding:1px 7px;border-radius:4px;font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:.5px;">${type}</span>`;
}

function gradeBadge(grade: string): string {
  const color = GRADE_COLOR[grade] ?? "#374151";
  return `<span style="display:inline-block;background:${color};color:#ffffff;padding:2px 9px;border-radius:4px;font-weight:bold;font-size:12px;font-family:Georgia,serif;">${grade}</span>`;
}

// One stacked card per catalyst — mirrors the website's CatalystCard.
function card(r: CveResult): string {
  const tvUrl = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(r.ticker)}`;
  const moveColor = r.changePct >= 0 ? "#16a34a" : "#dc2626";
  const head = r.headline
    ? `<div style="margin-top:7px;font-size:11px;line-height:1.4;">
         <a href="${r.newsUrl || tvUrl}" style="color:#64748b;text-decoration:none;font-style:italic;">“${r.headline}”</a>
         <span style="color:#b0b7c3;">${fmtAge(r.newsAgeHours)}</span>
       </div>`
    : "";
  return `
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;border-collapse:separate;margin:10px 0 0;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">
    <tr><td style="padding:12px 14px;font-family:Georgia,serif;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
        <tr>
          <td style="vertical-align:top;">
            <a href="${tvUrl}" style="color:#111;text-decoration:none;font-weight:bold;font-size:18px;">${r.ticker}</a>
            <span style="color:${moveColor};font-weight:bold;font-size:14px;">&nbsp;${fmtMove(r.changePct)}</span>
            <span style="color:#94a3b8;font-size:12px;">&nbsp;$${r.price.toFixed(2)}</span>
          </td>
          <td align="right" style="vertical-align:top;white-space:nowrap;">
            ${gradeBadge(r.grade)}
            <span style="color:#6b7280;font-size:12px;font-weight:bold;">&nbsp;${r.stopPct}% stop</span>
          </td>
        </tr>
      </table>
      <div style="margin-top:9px;font-size:12px;">
        ${chip(r.catalystType)}
        <span style="font-family:'Courier New',monospace;">&nbsp;&nbsp;${ratingSpan(r.magnitude.rating)} <span style="color:#b0b7c3;">×</span> ${ratingSpan(r.speed.rating)} <span style="color:#b0b7c3;">=</span> <span style="font-weight:bold;color:#111;">${r.grade}</span></span>
      </div>
      ${head}
      <div style="margin-top:7px;border-top:1px solid #eef0f2;padding-top:7px;font-size:11px;color:#475569;line-height:1.55;">${r.commentary}</div>
    </td></tr>
  </table>`;
}

function sectionCards(title: string, list: CveResult[], accent: string): string {
  const body = list.length
    ? list.map(card).join("")
    : `<div style="margin-top:8px;color:#94a3b8;font-style:italic;font-size:12px;">No B/A/A+ grade catalysts in this window.</div>`;
  return `
  <h2 style="font-family:Georgia,serif;font-size:15px;color:${accent};border-bottom:2px solid ${accent};padding-bottom:4px;margin:20px 0 4px;">
    ${title}
  </h2>
  ${body}`;
}

function matrixLegend(): string {
  const row = (combo: string, grade: string, stop: string, color: string) =>
    `<tr>
      <td style="border:1px solid #e5e7eb;padding:4px 8px;">${combo}</td>
      <td style="border:1px solid #e5e7eb;padding:4px 8px;text-align:center;font-weight:bold;color:${color};">${grade}</td>
      <td style="border:1px solid #e5e7eb;padding:4px 8px;text-align:center;">${stop}</td>
    </tr>`;
  return `
  <h3 style="font-family:Georgia,serif;font-size:13px;color:#334155;margin:22px 0 6px;">Grade matrix — CVE = Magnitude × Speed</h3>
  <table style="border-collapse:collapse;font-family:Georgia,serif;font-size:11px;color:#334155;">
    <thead>
      <tr style="color:#111;">
        <th style="border:1px solid #e5e7eb;padding:4px 8px;text-align:left;">Magnitude × Speed</th>
        <th style="border:1px solid #e5e7eb;padding:4px 8px;">Grade</th>
        <th style="border:1px solid #e5e7eb;padding:4px 8px;">Daily stop</th>
      </tr>
    </thead>
    <tbody>
      ${row("Absolute × Absolute", "A+", "80%", "#15803d")}
      ${row("Yes × Yes", "A", "30%", "#16a34a")}
      ${row("Yes × Maybe / Maybe × Yes", "B", "15%", "#ca8a04")}
      ${row("Maybe × Maybe", "C", "minor", "#94a3b8")}
      ${row("any “No”", "D", "0% — filtered", "#dc2626")}
    </tbody>
  </table>`;
}

export function buildEmailHtml(snap: CveSnapshot): string {
  // Bulletproof email layout: an outer 100% table centres a fixed 600px inner
  // table. Outlook.com ignores max-width on a <div>, which is why the previous
  // version stretched edge-to-edge — a fixed-width table is honoured everywhere.
  const inner = `
    <h1 style="font-size:22px;margin:0 0 2px;font-family:Georgia,serif;color:#111;">Catalyst Value Eval</h1>
    <p style="color:#6b7280;font-size:12px;margin:0 0 6px;text-transform:uppercase;letter-spacing:1px;font-family:Georgia,serif;">
      ${phaseLabel(snap.phase)} · ${snap.asOf} · CVE = Magnitude × Speed
    </p>
    ${sectionCards("Top 3 Positive (Bullish)", snap.positives, "#16a34a")}
    ${sectionCards("Top 3 Negative (Bearish)", snap.negatives, "#dc2626")}
    ${matrixLegend()}
    <p style="color:#94a3b8;font-size:11px;margin-top:18px;border-top:1px solid #e5e7eb;padding-top:8px;font-family:Georgia,serif;line-height:1.5;">
      Scanned ${snap.scanned} in-play names (${snap.discovered} discovered ·
      FinViz ${snap.sources.finviz}, Polygon movers ${snap.sources.polygonMovers}, news ${snap.sources.news}).
      Only B/A/A+ shown. A bearish name needs a true negative catalyst — the absence of an expected
      positive scores “No” on Magnitude = D = do not trade.
    </p>`;
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background:#fffdf9;">
    <tr><td align="center" style="padding:16px 8px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;border-collapse:collapse;text-align:left;">
        <tr><td style="padding:6px 4px;">${inner}</td></tr>
      </table>
    </td></tr>
  </table>`;
}

// ─── pushover ────────────────────────────────────────────────────────────────

function pushLine(r: CveResult): string {
  return `${r.direction === "positive" ? "▲" : "▼"} ${r.ticker} ${fmtMove(r.changePct)} [${r.grade} ${r.stopPct}%] ${r.magnitude.rating}×${r.speed.rating} ${r.catalystType}`;
}

export function buildPushoverMessage(snap: CveSnapshot): string {
  const pos = snap.positives.length ? snap.positives.map(pushLine).join("\n") : "(none)";
  const neg = snap.negatives.length ? snap.negatives.map(pushLine).join("\n") : "(none)";
  return `POSITIVE\n${pos}\n\nNEGATIVE\n${neg}`;
}

// ─── send ────────────────────────────────────────────────────────────────────

export interface NotifyResult {
  email: string;
  pushover: string;
}

export async function notify(snap: CveSnapshot): Promise<NotifyResult> {
  const result: NotifyResult = { email: "skipped", pushover: "skipped" };

  const reportTo = process.env.REPORT_TO_EMAIL;
  if (reportTo && process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    try {
      const total = snap.positives.length + snap.negatives.length;
      await sendHtmlEmail(
        reportTo,
        `Catalyst Value Eval · ${phaseLabel(snap.phase)} · ${total} catalysts`,
        buildEmailHtml(snap),
      );
      result.email = "sent";
    } catch (err) {
      result.email = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else {
    result.email = "skipped (no REPORT_TO_EMAIL or Gmail creds)";
  }

  if (process.env.PUSHOVER_USER_KEY && process.env.PUSHOVER_APP_TOKEN) {
    try {
      const body = new URLSearchParams({
        token: process.env.PUSHOVER_APP_TOKEN,
        user: process.env.PUSHOVER_USER_KEY,
        title: `CVE ${phaseLabel(snap.phase)}`,
        message: buildPushoverMessage(snap),
      });
      const resp = await fetch("https://api.pushover.net/1/messages.json", { method: "POST", body });
      result.pushover = resp.ok ? "sent" : `error: ${resp.status}`;
    } catch (err) {
      result.pushover = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else {
    result.pushover = "skipped (no Pushover creds)";
  }

  return result;
}
