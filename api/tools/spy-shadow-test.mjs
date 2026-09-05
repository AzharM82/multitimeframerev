/**
 * Unit tests for the SPY Conviction shadow-ledger rule. Runs against the
 * COMPILED output, same reason as spread-math-test.mjs: a test of a hand-copied
 * version of the logic passes while the shipped artefact is broken.
 *
 *   cd api && npm run build && node tools/spy-shadow-test.mjs
 *
 * No network, no storage. Bars are synthetic and small enough to reason about.
 */
import { simulate, summarize, sizeForAccount, contractSymbol, fridayOf, etToUtcMs, ema2, RULE } from "../dist/lib/spyShadow/rule.js";

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass += 1; else failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
}

// ─── Symbols and time ───────────────────────────────────────────────────────
check("friday of a Wednesday", fridayOf("2026-08-12"), "2026-08-14");
check("friday of a Friday is itself", fridayOf("2026-08-14"), "2026-08-14");
check("friday of a Monday", fridayOf("2026-08-31"), "2026-09-04");
check("call symbol rounds to ATM", contractSymbol("2026-08-12", "CALL", 773.43), "SPY260814C00773000");
check("put symbol", contractSymbol("2026-09-01", "PUT", 761.66), "SPY260904P00762000");
check("ET→UTC in EDT", new Date(etToUtcMs("2026-08-12", "14:40")).toISOString(), "2026-08-12T18:40:00.000Z");
check("ET→UTC in EST", new Date(etToUtcMs("2026-12-15", "14:40")).toISOString(), "2026-12-15T19:40:00.000Z");

// ─── Synthetic session ──────────────────────────────────────────────────────
// Signal: BUY_CALL, bar 14:40 ET (18:40Z). Alert bar = 18:40–18:42. Window = 18:42..18:51.
const DAY = "2026-08-12";
const T = (hhmm, sec = "00") => `${DAY}T${hhmm}:${sec}Z`;
const bar = (hhmm, o, h, l, c, v = 100) => ({ t: T(hhmm), o, h, l, c, v });

/** SPY 2-min bars from 18:20 with a flat-ish tape at 773, so the 9 EMA ≈ 773. */
function spy2Flat() {
  const out = [];
  for (let m = 0; m < 60; m += 2) {
    const hh = 18 + Math.floor((20 + m) / 60), mm = (20 + m) % 60;
    out.push(bar(`${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`, 773, 773.2, 772.8, 773));
  }
  return out;
}
/** SPY 1-min bars: price sits ABOVE the EMA (773.6) until `touchAt`, when the low dips to the EMA. */
function spy1(touchAt) {
  const out = [];
  for (let m = 0; m < 80; m++) {
    const hh = 18 + Math.floor((20 + m) / 60), mm = (20 + m) % 60;
    const k = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    out.push(k === touchAt ? bar(k, 773.6, 773.7, 772.9, 773.4) : bar(k, 773.6, 773.8, 773.5, 773.6));
  }
  return out;
}
/** Option 1-min bars from 18:40: a flat 3.00 until `after`, then a scripted path. */
function opt1(script) {
  const out = [];
  for (let m = 0; m < 80; m++) {
    const hh = 18 + Math.floor((40 + m) / 60), mm = (40 + m) % 60;
    const k = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    const s = script[k];
    out.push(s ? bar(k, ...s) : bar(k, 3.0, 3.02, 2.98, 3.0));
  }
  return out;
}
const SIG = { day: DAY, side: "CALL", barTime: `${DAY} 14:40:00`, spy: 773.43 };

// EMA sanity: flat tape → EMA equals the price.
check("ema2 of a flat tape", Number(ema2(spy2Flat()).at(-1).ema.toFixed(2)), 773);

// 1. No touch inside the window → NO_TOUCH, no trade.
{
  const r = simulate(SIG, spy1("19:10"), spy2Flat(), opt1({}));
  check("no touch in 10 min → NO_TOUCH", [r.status, r.entry, r.waitedMin], ["NO_TOUCH", null, -1]);
}
// 2. Touch at 18:45 (3 min into the window) → fill at that minute's option midpoint.
{
  const r = simulate(SIG, spy1("18:45"), spy2Flat(), opt1({ "18:45": [2.9, 2.94, 2.86, 2.9] }));
  check("touch → FILLED at midpoint", [r.status, r.touchMinuteUtc, r.waitedMin, r.entry], ["FILLED", "18:45", 3, 2.9]);
  check("flat after entry → EOD exit", [r.exitReason, r.exit], ["EOD", 3.0]);
  check("EOD ret% and $", [r.retPct, r.grossUsd, r.netUsd], [3.45, 10, 9.3]);
}
// 3. Target hit: +20% on a later bar's high → exit at exactly the target.
{
  const r = simulate(SIG, spy1("18:45"), spy2Flat(), opt1({ "18:45": [2.9, 2.94, 2.86, 2.9], "18:52": [3.3, 3.6, 3.3, 3.5] }));
  check("target fills at 1.20×entry", [r.exitReason, r.exit, r.retPct, r.grossUsd], ["TP", 3.48, 20, 58]);
  check("held minutes counts entry minute", r.heldMin, 8);
  check("alt targets flagged", [r.tp10Hit, r.tp15Hit], [true, true]);
}
// 4. Stop hit: −9% on a later bar's low → exit at the stop, tp flags stay false.
{
  const r = simulate(SIG, spy1("18:45"), spy2Flat(), opt1({ "18:45": [2.9, 2.94, 2.86, 2.9], "18:50": [2.8, 2.82, 2.5, 2.6] }));
  check("stop fills at 0.91×entry, to the cent", [r.exitReason, r.exit, r.retPct], ["SL", 2.64, -8.97]);
  check("no alt target before stop", [r.tp10Hit, r.tp15Hit], [false, false]);
}
// 5. Stop and target in the SAME bar → the stop wins (conservative).
{
  const r = simulate(SIG, spy1("18:45"), spy2Flat(), opt1({ "18:45": [2.9, 2.94, 2.86, 2.9], "18:50": [2.9, 3.6, 2.5, 3.0] }));
  check("stop before target in one bar", r.exitReason, "SL");
}
// 6. The entry minute never counts toward the target or the excursion (we cannot
//    know whether its high printed before or after our fill), but its low can stop us.
//    Note a midpoint fill makes "target inside the entry bar without the stop" geometrically
//    impossible (h ≥ 1.5·l and h < 1.2·l cannot both hold), so that case is not a test.
{
  const r = simulate(SIG, spy1("18:45"), spy2Flat(), opt1({ "18:45": [2.9, 3.2, 2.86, 3.1] }));
  check("entry-bar high excluded from MFE", [r.exitReason, r.mfePct], ["EOD", 0]);
  const r2 = simulate(SIG, spy1("18:45"), spy2Flat(), opt1({ "18:45": [2.9, 2.94, 2.0, 2.9] }));
  check("stop inside entry minute honoured", r2.exitReason, "SL");
}
// 7. Touch exactly at the window's last minute (18:51) counts; 18:52 does not.
{
  check("touch at minute 10 counts", simulate(SIG, spy1("18:51"), spy2Flat(), opt1({})).status, "FILLED");
  check("touch at minute 11 is late", simulate(SIG, spy1("18:52"), spy2Flat(), opt1({})).status, "NO_TOUCH");
}
// 8. Missing data is NO_DATA with a reason, never a throw.
{
  check("no option bars", simulate(SIG, spy1("18:45"), spy2Flat(), []).status, "NO_DATA");
  check("no SPY bars", simulate(SIG, [], [], opt1({})).status, "NO_DATA");
}
// 9. The EMA a minute sees is the last COMPLETED 2-min bar.
{
  // Make the 18:44 2-min bar close far above; a touch at 18:45 must still use the EMA that includes it,
  // while a touch at 18:44 (bar still forming) must NOT.
  const s2 = spy2Flat().map((b) => (b.t === T("18:44") ? bar("18:44", 773, 790, 773, 790) : b));
  const emaBefore = ema2(s2).find((p) => p.closeMs === Date.parse(T("18:44"))).ema; // EMA through the 18:42 bar
  const emaAfter = ema2(s2).find((p) => p.closeMs === Date.parse(T("18:46"))).ema;  // includes the 790 close
  const one = spy1("18:44").map((b) => (b.t === T("18:44") ? bar("18:44", 773.6, 773.7, 772.9, 773.4) : b));
  const rA = simulate(SIG, one, s2, opt1({}));
  check("forming bar not visible at 18:44", [rA.status, rA.emaAtTouch], ["FILLED", Number(emaBefore.toFixed(2))]);
  // The 18:44 bar closes at 18:46 — that is the first minute its EMA can be seen.
  const two = spy1("18:46").map((b) => (b.t === T("18:46") ? bar("18:46", 776, 776.5, 774.5, 775) : b)); // range spans emaAfter (776.4)
  const rB = simulate(SIG, two, s2, opt1({}));
  check("completed bar visible at 18:46", [rB.status, rB.emaAtTouch], ["FILLED", Number(emaAfter.toFixed(2))]);
  const notYet = spy1("18:45").map((b) => (b.t === T("18:45") ? bar("18:45", 776, 776.5, 774.5, 775) : b));
  check("same range one minute earlier sees the old EMA → no touch", simulate(SIG, notYet, s2, opt1({})).status, "NO_TOUCH");
}

// ─── Summary ────────────────────────────────────────────────────────────────
{
  const rows = [
    { day: "2026-08-12", side: "CALL", status: "FILLED", entry: 2.9, grossUsd: 58, netUsd: 57.3, exitReason: "TP" },
    { day: "2026-08-12", side: "PUT", status: "FILLED", entry: 3.1, grossUsd: -26, netUsd: -26.7, exitReason: "SL" },
    { day: "2026-08-13", side: "PUT", status: "NO_TOUCH", entry: null, grossUsd: null, netUsd: null, exitReason: "" },
    { day: "2026-08-14", side: "CALL", status: "FILLED", entry: 4.0, grossUsd: -50, netUsd: -50.7, exitReason: "EOD" },
  ];
  const s = summarize(rows);
  check("counts", [s.signals, s.filled, s.noTouch, s.wins, s.losses, s.winRate], [4, 3, 1, 1, 2, 33]);
  check("money", [s.grossUsd, s.commissionUsd, s.netUsd], [-18, 2.1, -20.1]);
  check("drawdown from the peak", s.maxDrawdownUsd, -50.7);
  check("equity curve per day", s.equity, [{ day: "2026-08-12", netUsd: 30.6 }, { day: "2026-08-13", netUsd: 30.6 }, { day: "2026-08-14", netUsd: -20.1 }]);
  check("by side", s.bySide, { CALL: { filled: 2, wins: 1, netUsd: 6.6 }, PUT: { filled: 1, wins: 0, netUsd: -26.7 } });
  check("by exit", s.byExit, { TP: 1, SL: 1, EOD: 1 });
}
// ─── Account sizing ─────────────────────────────────────────────────────────
{
  check("account constant", RULE.ACCOUNT_USD, 2000);
  // $2.90 entry → 6 contracts ($1,740); +$58 gross per contract → $348 gross, $4.20 fees.
  check("6 contracts at 2.90", sizeForAccount(2.9, 58), { contracts: 6, costUsd: 1740, grossUsd: 348, commissionUsd: 4.2, netUsd: 343.8, retPct: 17.19 });
  // $0.88 entry → 22 contracts; a −9% stop on 0.88 is −$7.92/contract.
  check("22 contracts at 0.88, losing", sizeForAccount(0.88, -7.92), { contracts: 22, costUsd: 1936, grossUsd: -174.24, commissionUsd: 15.4, netUsd: -189.64, retPct: -9.48 });
  check("premium above the account → 0 contracts", sizeForAccount(25, 100).contracts, 0);
  const rows = [
    { day: "2026-08-12", side: "CALL", status: "FILLED", entry: 2.9, grossUsd: 58, netUsd: 57.3, exitReason: "TP" },
    { day: "2026-08-12", side: "PUT", status: "FILLED", entry: 2.0, grossUsd: -18, netUsd: -18.7, exitReason: "SL" },
    { day: "2026-08-13", side: "PUT", status: "NO_TOUCH", entry: null, grossUsd: null, netUsd: null, exitReason: "" },
  ];
  const a = summarize(rows).account;
  // CALL: 6 × 58 − 4.2 = 343.8 ; PUT: 10 × −18 − 7 = −187 ; total 156.8 = 7.84% of 2000.
  check("account totals", [a.sizeUsd, a.grossUsd, a.commissionUsd, a.netUsd, a.retPct], [2000, 168, 11.2, 156.8, 7.84]);
  check("account by side", a.bySide, { CALL: 343.8, PUT: -187 });
  check("account equity in $ and %", a.equity, [{ day: "2026-08-12", netUsd: 156.8, pct: 7.84 }, { day: "2026-08-13", netUsd: 156.8, pct: 7.84 }]);
  check("account best/worst/avg", [a.bestTradeUsd, a.worstTradeUsd, a.avgContracts], [343.8, -187, 8]);
  check("account drawdown never positive", a.maxDrawdownUsd <= 0 && a.maxDrawdownPct <= 0, true);
}
check("rule label mentions its own numbers", RULE.label.includes(`${RULE.TARGET_PCT}%`) && RULE.label.includes(`${RULE.STOP_PCT}%`), true);

console.log(`${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
