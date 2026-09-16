/**
 * Alert selection — assertions, no network.
 *
 *   node test/uoa-alerts-test.mjs
 *
 * Every check here exists because this code sends real messages to a real
 * phone every two minutes for six and a half hours. It is exercised as pure
 * functions precisely so nobody has to test it by letting it fire.
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const A = require("../src/uoa/alerts.js");

let checks = 0;
const fails = [];
const ok = (c, w) => { checks += 1; if (!c) fails.push(w); };
const eq = (a, e, w) => ok(Object.is(a, e), `${w} — expected ${e}, got ${a}`);

const cfg = A.DEFAULT_ALERT;
const T0 = new Date("2026-09-14T14:00:00Z");
const at = (mins) => new Date(T0.getTime() + mins * 60_000);

const burst = (o = {}) => ({
  underlying: "NVDA", type: "C", strike: 200, expiry: "2026-10-16", dte: 32,
  lots: 1_000, notional: 1_200_000, oi_share: 0.5, side: "bought", ...o,
});

// ── the bar ────────────────────────────────────────────────────────────────
ok(A.qualifies(burst(), cfg), "$1.2m committed in one window qualifies");
ok(!A.qualifies(burst({ notional: 600_000, oi_share: 0.5 }), cfg),
  "$600k at half the open interest shows in the tab but does not ring a phone");
ok(A.qualifies(burst({ notional: 600_000, oi_share: 2.5 }), cfg),
  "trading 2.5x all outstanding interest qualifies on its own");
ok(!A.qualifies(burst({ notional: 100_000, oi_share: 0.2 }), cfg), "ordinary is ordinary");

// ── one line per name ──────────────────────────────────────────────────────
// Five strikes of the same expiry is one position being built, not five events.
const legs = [
  burst({ strike: 200, notional: 1_200_000, lots: 1_000 }),
  burst({ strike: 205, notional: 2_000_000, lots: 1_500 }),
  burst({ strike: 210, notional: 1_100_000, lots: 900 }),
  burst({ underlying: "TSLA", strike: 400, notional: 3_000_000, lots: 2_000 }),
];
let g = A.groupByUnderlying(legs, cfg);
eq(g.length, 2, "three NVDA strikes collapse to one line");
// NVDA's three legs total $4.3m against TSLA's single $3m, so NVDA leads —
// which is the point of summing the name rather than ranking on its best leg.
eq(g[0].underlying, "NVDA", "names ranked by the whole name's dollars, not its biggest leg");
eq(g[0].legs, 3, "the leg count is kept");
eq(g[0].notional, 4_300_000, "the name's whole window is summed");
eq(g[0].top.strike, 205, "the line describes the largest single contract");
eq(g[1].underlying, "TSLA", "the single-leg name ranks below it");
eq(A.groupByUnderlying([burst({ notional: 1_000 })], cfg).length, 0, "nothing qualifying, nothing grouped");

// ── cooldown, escalation, cap ──────────────────────────────────────────────
let state = { alerted: {}, sent: 0 };
let sel = A.selectAlerts([burst()], state, T0, cfg);
eq(sel.lines.length, 1, "a fresh name alerts");
state = A.markSent(state, sel.lines, T0);
eq(state.sent, 1, "the session counter advances once per message, not per name");

sel = A.selectAlerts([burst()], state, at(5), cfg);
eq(sel.lines.length, 0, "the same name five minutes later stays quiet");

sel = A.selectAlerts([burst({ notional: 1_500_000 })], state, at(5), cfg);
eq(sel.lines.length, 0, "a slightly bigger repeat is still the same story");

sel = A.selectAlerts([burst({ notional: 4_000_000 })], state, at(5), cfg);
eq(sel.lines.length, 1, "but 3x bigger inside the cooldown is an escalation and breaks through");

sel = A.selectAlerts([burst()], state, at(31), cfg);
eq(sel.lines.length, 1, "after the cooldown the name is heard again");

// A different name is never suppressed by another's cooldown.
sel = A.selectAlerts([burst({ underlying: "AMD" })], state, at(1), cfg);
eq(sel.lines.length, 1, "a different name is unaffected by NVDA's cooldown");

// The daily cap is absolute.
eq(A.selectAlerts([burst({ underlying: "XYZ" })], { alerted: {}, sent: cfg.maxPerSession }, T0, cfg).lines.length,
  0, "the session cap stops everything");
eq(A.selectAlerts([burst({ underlying: "XYZ" })], { alerted: {}, sent: cfg.maxPerSession }, T0, cfg).suppressed,
  "session_cap", "and says why");
eq(A.selectAlerts([burst()], { alerted: {}, sent: cfg.maxPerSession - 1 }, T0, cfg).lines.length,
  1, "one under the cap still sends");

// Lines per message are capped so a phone notification stays readable.
const many = Array.from({ length: 12 }, (_, i) => burst({ underlying: `S${i}`, notional: 2_000_000 - i }));
eq(A.selectAlerts(many, { alerted: {}, sent: 0 }, T0, cfg).lines.length, cfg.maxLines,
  "at most six names in one message");
eq(A.selectAlerts(many, { alerted: {}, sent: 0 }, T0, cfg).lines[0].underlying, "S0",
  "and they are the biggest six");

eq(A.selectAlerts([], { alerted: {}, sent: 0 }, T0, cfg).lines.length, 0, "no bursts, no alert");

// ── the message ────────────────────────────────────────────────────────────
let m = A.formatMessage([A.groupByUnderlying([burst()], cfg)[0]], { windowSeconds: 120 });
eq(m.title, "Options flow: NVDA", "one name in the title");
ok(m.body.includes("NVDA 200C 10-16 (32d)"), "contract spelled out");
ok(m.body.includes("+1,000 contracts"), "lots are thousands-separated for a phone");
ok(m.body.includes("$1.2M"), "money is short form");
ok(m.body.includes("50% of OI"), "share of open interest");
ok(m.body.includes("at ask"), "the lean is words, not a symbol");
ok(m.body.includes("yesterday's settlement"), "the message repeats what the number is not");
ok(m.body.includes("a lean not a fact"), "and that the side is inferred");
ok(!m.body.includes("*") && !m.body.includes("<"), "plain text — WhatsApp and Pushover render differently");

m = A.formatMessage(A.groupByUnderlying(legs, cfg), {});
eq(m.title, "Options flow: NVDA, TSLA", "every name in the title, biggest first");
ok(m.body.includes("(+2 more strikes, $4.3M total)"), "extra legs summarised on the name's line");

m = A.formatMessage([A.groupByUnderlying([burst({ oi_share: 14, notional: 1_100_000 })], cfg)[0]], {});
ok(m.body.includes("14x OI"), "a huge share reads as a multiple, not 1400%");

m = A.formatMessage([A.groupByUnderlying([burst({ side: null })], cfg)[0]], {});
ok(!m.body.includes("at ask") && !m.body.includes("at bid"), "an unknown lean is simply left out");

m = A.formatMessage([A.groupByUnderlying([burst({ strike: 207.5 })], cfg)[0]], {});
ok(m.body.includes("207.50C"), "a half-dollar strike keeps its cents");

if (fails.length) {
  console.error(`FAIL — ${fails.length} of ${checks} checks\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
console.log(`PASS — ${checks} assertions (bar + grouping + cooldown + cap + message)`);
