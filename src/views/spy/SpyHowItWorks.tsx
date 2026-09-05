/**
 * SPY Conviction — "How it works".
 *
 * The end-to-end story of the system in one place: where the signal comes
 * from, how a decision is made, exactly how the shadow ledger enters, exits
 * and sizes a trade, how to read the ledger, and how the rule was arrived at.
 *
 * Every number that belongs to the rule (wait window, EMA length, target, stop,
 * commission, account) is READ from the API's `params`, never typed here, so
 * this page cannot drift from api/src/lib/spyShadow/rule.ts. The diagrams are
 * hand-drawn SVG on `currentColor`, like every other chart in the portal, so
 * they follow the theme and need no library.
 */

import type { SpyShadowResponse } from "../../types.js";

type Params = SpyShadowResponse["params"];

const FALLBACK: Params = { waitMin: 10, emaLen: 9, targetPct: 20, stopPct: 9, commissionRt: 0, accountUsd: 2000 };

export function SpyHowItWorks({ params, rule }: { params: Params | null; rule: string | null }) {
  const p = params ?? FALLBACK;
  return (
    <div className="space-y-3">
      <Card title="1 · The pipeline, end to end">
        <p className="text-xs text-text-secondary">
          Nothing in this chain places an order. TradingView decides, the portal records and notifies,
          and after the close a cron scores what the fixed rule <em>would</em> have done.
        </p>
        <Pipeline />
        <ol className="text-[11px] text-text-secondary space-y-1 list-decimal pl-4">
          <li><b className="text-text-primary">Indicator.</b> A Pine script on the 10-minute SPY chart scores six legs on every closed bar and emits a decision.</li>
          <li><b className="text-text-primary">Webhook.</b> The decision posts to the portal with a shared secret in the body. Every hit is logged, including rejects, so a wrong secret never looks like a quiet market.</li>
          <li><b className="text-text-primary">Record and notify.</b> ARM, BUY, REDUCE, SELL and CANCEL go to the phone; HOLD and STAND_ASIDE are the silent majority.</li>
          <li><b className="text-text-primary">Score at 4:20 PM ET.</b> A cron pulls SPY and option 1-minute bars for the day and applies the rule below to every accepted BUY.</li>
          <li><b className="text-text-primary">Ledger.</b> The result is written once per alert and never purged, so the rule is judged on days it has not seen.</li>
        </ol>
      </Card>

      <Card title="2 · From six legs to a decision">
        <p className="text-xs text-text-secondary">
          Each leg votes on direction. The votes collapse into one score from −100 to +100 plus a count of legs that agree.
          The indicator then moves through a small set of states; the portal only mirrors them.
        </p>
        <LegsToScore />
        <StateMachine />
        <ul className="text-[11px] text-text-secondary space-y-1 list-disc pl-4">
          <li><b className="text-text-primary">ARM</b> means the score is strong but price is too extended to chase. It waits for a trigger such as a VWAP or EMA-9 reclaim, or cancels.</li>
          <li><b className="text-text-primary">BUY</b> is the only event the ledger trades. A BUY that arrives while the portal already believes it is long is flagged, not traded twice.</li>
          <li><b className="text-text-primary">HOLD / REDUCE / SELL</b> describe what the indicator thinks of an open position. The ledger ignores them on purpose: its exits are mechanical, and the fast SELL was shown to give the move back.</li>
          <li><b className="text-text-primary">STAND_ASIDE</b> is the idle heartbeat and always lands flat.</li>
        </ul>
      </Card>

      <Card title="3 · Entry: wait for the pullback to the 9 EMA">
        <p className="text-xs text-text-secondary">
          The alert lands at a 10-minute bar close. Let the 2-minute bar that contains it finish, then watch the next{" "}
          <b className="text-text-primary">{p.waitMin} minutes</b> ({p.waitMin / 2} two-minute bars) for SPY to touch the{" "}
          <b className="text-text-primary">{p.emaLen} EMA of 2-minute closes</b>. Buy in the minute of the touch.
        </p>
        <EntryDiagram waitMin={p.waitMin} emaLen={p.emaLen} />
        <ul className="text-[11px] text-text-secondary space-y-1 list-disc pl-4">
          <li><b className="text-text-primary">Contract.</b> SPY at-the-money strike, rounded from SPY at the signal, expiring that week&apos;s Friday. A Friday signal is same-day expiry.</li>
          <li><b className="text-text-primary">Touch.</b> Checked minute by minute: a minute whose low-to-high range contains the EMA value counts. A 2-minute bar touches only if one of its minutes does, so the event is the same, just caught sooner.</li>
          <li><b className="text-text-primary">Which EMA value.</b> The EMA of the last <em>completed</em> 2-minute bar, never the bar still forming. That is the level a trader could actually have known.</li>
          <li><b className="text-text-primary">Fill.</b> The midpoint of the option&apos;s 1-minute bar in the touch minute (high + low over 2). If the option did not print that minute, the next printed minute within two is used.</li>
          <li><b className="text-text-primary">No touch.</b> Price runs away without pulling back inside the window: no trade, recorded as &ldquo;no touch&rdquo; so skipped signals stay visible.</li>
        </ul>
      </Card>

      <Card title={`4 · Exit: +${p.targetPct}% target, −${p.stopPct}% stop, else the close`}>
        <p className="text-xs text-text-secondary">
          Three exits only, all on the option price, none discretionary. From the entry minute onward every 1-minute bar is checked in this order.
        </p>
        <ExitDiagram targetPct={p.targetPct} stopPct={p.stopPct} />
        <ul className="text-[11px] text-text-secondary space-y-1 list-disc pl-4">
          <li><b className="text-text-primary">Stop first.</b> If the bar&apos;s low is at or below entry × {(1 - p.stopPct / 100).toFixed(2)}, exit at the stop price. The entry minute itself counts.</li>
          <li><b className="text-text-primary">Then target.</b> If the bar&apos;s high reaches entry × {(1 + p.targetPct / 100).toFixed(2)}, exit at the target. Not inside the entry minute, because we cannot know whether that high printed before or after the fill.</li>
          <li><b className="text-text-primary">Tie goes to the loss.</b> A single bar that spans both levels is scored as a stop.</li>
          <li><b className="text-text-primary">Otherwise the close.</b> The last bar of the session, 15:59 ET. Never overnight.</li>
          <li><b className="text-text-primary">Not modelled.</b> Slippage, a gap through the stop, or a low that was one print at the bid. Live fills would be a little worse than the ledger.</li>
        </ul>
      </Card>

      <Card title="5 · Sizing and accounting">
        <div className="grid md:grid-cols-2 gap-3 text-[11px] text-text-secondary">
          <ul className="space-y-1 list-disc pl-4">
            <li><b className="text-text-primary">Account.</b> ${p.accountUsd.toLocaleString()}, fixed. Every trade is judged against the same balance; profits are not compounded, so percentages stay comparable day to day.</li>
            <li><b className="text-text-primary">Quantity.</b> Every contract the account buys at the entry: floor({p.accountUsd.toLocaleString()} ÷ (entry × 100)). A $3.00 option is 6 contracts; a $0.80 option is 25.</li>
            <li><b className="text-text-primary">Dollars.</b> (exit − entry) × 100 × contracts. Percent is against the whole account, not the premium.</li>
          </ul>
          <ul className="space-y-1 list-disc pl-4">
            <li><b className="text-text-primary">Commission.</b> {p.commissionRt ? `$${p.commissionRt.toFixed(2)} per contract round trip.` : "None per contract: the ledger assumes Tradier Pro, where SPY options are commission-free for a flat $10 a month that is not modelled."}</li>
            <li><b className="text-text-primary">Sizing is applied when the ledger is read</b>, from the stored entry price. Changing the account size or commission re-prices the whole history the same way.</li>
            <li><b className="text-text-primary">Why all-in is shown.</b> It is the operator&apos;s stated plan. Its drawdown scales one-for-one with position size, so half size halves both the return and the drawdown.</li>
          </ul>
        </div>
      </Card>

      <Card title="6 · Reading the ledger">
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <tbody>
              {GLOSSARY.map(([k, v]) => (
                <tr key={k} className="border-b border-border/40 last:border-b-0">
                  <td className="py-1 pr-3 whitespace-nowrap font-semibold text-text-primary align-top">{k}</td>
                  <td className="py-1 text-text-secondary">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-text-secondary">
          <b className="text-text-primary">How to judge it.</b> Ignore any single day. After two weeks of forward data, look at three things together: is net still positive
          after the backfill period is excluded, is the drawdown inside what the account can take, and is the win rate holding near the backfill&apos;s 42%.
          A rule that only works on the days it was found on will show it here first.
        </p>
      </Card>

      <Card title="7 · How this rule was arrived at">
        <p className="text-xs text-text-secondary">
          Everything below was measured on the same 35 to 39 BUY alerts from 2026-08-12 to 09-04, using real 1-minute option bars. The order matters:
          each step removed one plausible explanation for the profits the operator remembered seeing.
        </p>
        <ol className="text-[11px] text-text-secondary space-y-1 list-decimal pl-4">
          <li><b className="text-text-primary">Underlying only.</b> SPY points from BUY to the indicator&apos;s SELL: 18% wins, breakeven. The direction calls were real but thin.</li>
          <li><b className="text-text-primary">Buy the next bar&apos;s open.</b> Every target and stop combination between 10% and 30% landed within a few dollars of zero per contract.</li>
          <li><b className="text-text-primary">Stop at the alert bar&apos;s low.</b> A median 2% away: 31 of 38 stopped out in minutes. Too tight to survive noise.</li>
          <li><b className="text-text-primary">Midpoint instead of open.</b> Worse, not better: on winners the option is already rising during that bar.</li>
          <li><b className="text-text-primary">Buy the bar&apos;s low.</b> The ceiling of any entry inside that bar was about $5 per contract per trade, so the whole edge lived in a two-minute fill.</li>
          <li><b className="text-text-primary">Wait for the pullback.</b> Requiring a touch of the 2-minute 9 EMA within 10 minutes lifted the win rate from the high twenties to the fifties and made the result stop depending on a perfect fill. The 21 EMA touched too rarely; VWAP almost never within the window.</li>
          <li><b className="text-text-primary">Exit rule.</b> Obeying the indicator&apos;s SELL, a median 10 minutes after entry, gave the move back every time. Holding to a mechanical target, stop or close is what kept the gains.</li>
          <li><b className="text-text-primary">Sizing.</b> All-in produced +54% with a −38% drawdown on the backfill; one third size gave +15% with −8%. Day-loss stops and trade caps did not help, and a &ldquo;sit out after two losses&rdquo; rule that looked spectacular was rejected as a fit to the sequence.</li>
        </ol>
        <p className="text-[11px] text-dim">
          The backfilled numbers are deliberately lower than the research scripts that found the rule: the ledger uses the completed-bar EMA and refuses a target fill inside the entry minute.
          Rule label in code: <span className="text-text-secondary">{rule ?? "—"}</span>.
        </p>
      </Card>
    </div>
  );
}

const GLOSSARY: [string, string][] = [
  ["Alert", "Pacific time of the 10-minute bar close that produced the BUY. Hover for the score and the trigger."],
  ["Contract", "OCC symbol of the at-the-money SPY option expiring that Friday."],
  ["Touch", "When SPY touched the 9 EMA and how many minutes after the alert bar closed. “No touch in 10m” means no trade."],
  ["Entry / Exit", "Option prices: the midpoint in the touch minute, and the target, stop or closing price."],
  ["Why", "Which exit fired: target, stop or close."],
  ["Ret", "Percent change of the option from entry to exit."],
  ["Qty", "Contracts the account buys at the entry."],
  ["Net $ / Acct %", "Dollars for that quantity, and the same as a percent of the account."],
  ["Held", "Minutes from entry to exit."],
  ["Peak", "The best the option got after entry and before the exit, as a percent. Context for whether the target is set well."],
  ["10 / 15%", "Whether smaller targets would have filled before the stop. Lets the review compare targets without re-running anything."],
  ["Header", "Cumulative net and percent on the account across every scored day, with drawdown measured on closing equity."],
];

// ─── Layout helpers ─────────────────────────────────────────────────────────

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-bg-card border border-border rounded">
      <div className="card-header px-3 pt-2.5 pb-1.5 border-b-2 border-text-primary">{title}</div>
      <div className="px-3 py-3 space-y-3">{children}</div>
    </div>
  );
}

/** Rounded box with one or two lines of centred text. */
function Box({ x, y, w, h, lines, strong }: { x: number; y: number; w: number; h: number; lines: string[]; strong?: boolean }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={4} fill={strong ? "currentColor" : "none"} stroke="currentColor"
        className={strong ? "text-text-primary" : "text-border"} strokeWidth={1} />
      {lines.map((t, i) => (
        <text key={i} x={x + w / 2} y={y + h / 2 + (i - (lines.length - 1) / 2) * 11 + 3.5} textAnchor="middle" fontSize={9}
          className={strong ? "fill-current text-bg-card" : i === 0 ? "fill-current text-text-primary" : "fill-current text-text-secondary"}>
          {t}
        </text>
      ))}
    </g>
  );
}

function Arrow({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const hx = x2 - 5 * Math.cos(a), hy = y2 - 5 * Math.sin(a);
  return (
    <g stroke="currentColor" className="text-text-secondary" strokeWidth={1} fill="currentColor">
      <line x1={x1} y1={y1} x2={hx} y2={hy} />
      <polygon points={`${x2},${y2} ${hx - 3 * Math.sin(a)},${hy + 3 * Math.cos(a)} ${hx + 3 * Math.sin(a)},${hy - 3 * Math.cos(a)}`} />
    </g>
  );
}

// ─── Diagrams ───────────────────────────────────────────────────────────────

function Pipeline() {
  const steps = [
    ["TradingView", "10-min SPY · 6 legs"],
    ["Webhook", "secret in body"],
    ["Portal", "records · notifies"],
    ["Cron 4:20 PM ET", "after the close"],
    ["Alpaca bars", "SPY + option 1-min"],
    ["Fixed rule", "entry · exit · size"],
    ["Ledger", "kept forever"],
  ];
  const W = 760, bw = 92, gap = 18, y = 14, h = 34;
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} 62`} className="w-full min-w-[720px]" role="img" aria-label="signal pipeline">
        {steps.map(([a, b], i) => {
          const x = 6 + i * (bw + gap);
          return (
            <g key={a}>
              <Box x={x} y={y} w={bw} h={h} lines={[a, b]} strong={i === 5} />
              {i < steps.length - 1 && <Arrow x1={x + bw} y1={y + h / 2} x2={x + bw + gap} y2={y + h / 2} />}
            </g>
          );
        })}
        <text x={6} y={58} fontSize={8} className="fill-current text-dim">Phone alerts leave at step 3. Nothing after step 3 can place an order.</text>
      </svg>
    </div>
  );
}

function LegsToScore() {
  const legs = ["Cumulative TICK", "Volume pressure", "SPY vs VWAP", "SPY vs EMA 9", "SPY / RSP lead", "VIX"];
  const W = 760, H = 150;
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[720px]" role="img" aria-label="six legs to one score">
        {legs.map((l, i) => {
          const y = 8 + i * 23;
          return (
            <g key={l}>
              <Box x={6} y={y} w={120} h={18} lines={[l]} />
              <Arrow x1={126} y1={y + 9} x2={228} y2={78} />
            </g>
          );
        })}
        <Box x={230} y={58} w={110} h={40} lines={["Score −100 … +100", "+ legs agreeing (n/6)"]} strong />
        <Arrow x1={340} y1={78} x2={392} y2={78} />
        {/* gauge */}
        <line x1={396} y1={78} x2={596} y2={78} stroke="currentColor" className="text-border" strokeWidth={4} strokeLinecap="round" />
        <line x1={396} y1={78} x2={456} y2={78} stroke="currentColor" className="text-signal-bear" strokeWidth={4} strokeLinecap="round" />
        <line x1={536} y1={78} x2={596} y2={78} stroke="currentColor" className="text-signal-bull" strokeWidth={4} strokeLinecap="round" />
        <text x={396} y={94} fontSize={8} className="fill-current text-signal-bear">−100 · strong put</text>
        <text x={496} y={94} fontSize={8} textAnchor="middle" className="fill-current text-text-secondary">weak · stand aside</text>
        <text x={596} y={94} fontSize={8} textAnchor="end" className="fill-current text-signal-bull">strong call · +100</text>
        <text x={496} y={66} fontSize={8} textAnchor="middle" className="fill-current text-text-secondary">grade: WEAK / STRONG · bias: upside / downside</text>
        <Box x={620} y={48} w={130} h={60} lines={["Decision", "ARM · BUY · HOLD", "REDUCE · SELL", "STAND_ASIDE"]} />
        <Arrow x1={598} y1={78} x2={618} y2={78} />
        <text x={6} y={H - 4} fontSize={8} className="fill-current text-dim">A BUY needs a strong score, most legs agreeing, and an entry trigger (VWAP or EMA-9 reclaim) that is not already too extended.</text>
      </svg>
    </div>
  );
}

function StateMachine() {
  const W = 760, H = 120;
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[720px]" role="img" aria-label="position states">
        <Box x={330} y={44} w={100} h={30} lines={["FLAT"]} strong />
        <Box x={110} y={10} w={110} h={26} lines={["ARMED_CALL"]} />
        <Box x={110} y={84} w={110} h={26} lines={["ARMED_PUT"]} />
        <Box x={540} y={10} w={110} h={26} lines={["LONG_CALL"]} />
        <Box x={540} y={84} w={110} h={26} lines={["LONG_PUT"]} />
        {/* FLAT -> ARMED */}
        <Arrow x1={330} y1={52} x2={222} y2={26} />
        <text x={262} y={32} fontSize={8} textAnchor="middle" className="fill-current text-text-secondary">ARM_CALL</text>
        <Arrow x1={330} y1={66} x2={222} y2={94} />
        <text x={262} y={92} fontSize={8} textAnchor="middle" className="fill-current text-text-secondary">ARM_PUT</text>
        {/* ARMED -> FLAT (cancel) */}
        <Arrow x1={200} y1={36} x2={330} y2={60} />
        <text x={278} y={56} fontSize={8} textAnchor="middle" className="fill-current text-dim">ARM_CANCEL</text>
        <Arrow x1={200} y1={84} x2={330} y2={62} />
        {/* ARMED -> LONG (buy) across the top/bottom */}
        <path d="M 220 16 Q 380 -6 540 16" fill="none" stroke="currentColor" className="text-signal-bull" strokeWidth={1.25} />
        <polygon points="540,16 533,12 534,19" fill="currentColor" className="text-signal-bull" />
        <text x={380} y={8} fontSize={8} textAnchor="middle" className="fill-current text-signal-bull">BUY_CALL  ← the ledger trades this</text>
        <path d="M 220 104 Q 380 126 540 104" fill="none" stroke="currentColor" className="text-signal-bear" strokeWidth={1.25} />
        <polygon points="540,104 533,101 534,108" fill="currentColor" className="text-signal-bear" />
        <text x={380} y={118} fontSize={8} textAnchor="middle" className="fill-current text-signal-bear">BUY_PUT  ← and this</text>
        {/* FLAT -> LONG direct (buy without arm) */}
        <Arrow x1={430} y1={52} x2={540} y2={26} />
        <Arrow x1={430} y1={66} x2={540} y2={94} />
        {/* LONG -> FLAT (sell) */}
        <Arrow x1={560} y1={36} x2={430} y2={58} />
        <text x={498} y={54} fontSize={8} textAnchor="middle" className="fill-current text-dim">SELL / STAND_ASIDE</text>
        <Arrow x1={560} y1={84} x2={430} y2={64} />
        <text x={595} y={62} fontSize={8} className="fill-current text-dim">HOLD · REDUCE stay</text>
      </svg>
    </div>
  );
}

function EntryDiagram({ waitMin, emaLen }: { waitMin: number; emaLen: number }) {
  const W = 760, H = 190, L = 40, R = 16, TOP = 16, BOT = 130;
  const bars = waitMin / 2; // two-minute bars in the window
  const slot = (W - L - R) / (bars + 3); // 1 alert bar + window + 2 context bars
  const x = (i: number) => L + i * slot;
  // price path: alert bar closes strong, next bars pull back to the EMA, then resume
  const price = [58, 46, 40, 48, 60, 66, 52, 44, 38, 30, 26];
  const ema = [80, 76, 72, 68, 65, 63, 62, 61, 60, 58, 56];
  const pt = (arr: number[]) => arr.slice(0, bars + 3).map((v, i) => `${x(i) + slot / 2},${TOP + v}`).join(" ");
  const touchIdx = ema.findIndex((e, i) => i >= 2 && Math.abs(price[i] - e) < 6);
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[720px]" role="img" aria-label="entry timing">
        {/* bar slots */}
        {Array.from({ length: bars + 3 }, (_, i) => (
          <rect key={i} x={x(i) + 2} y={TOP} width={slot - 4} height={BOT - TOP} rx={2}
            fill={i === 1 ? "currentColor" : i >= 2 && i < bars + 2 ? "currentColor" : "none"}
            className={i === 1 ? "text-text-secondary" : "text-border"} opacity={i === 1 ? 0.18 : i >= 2 && i < bars + 2 ? 0.28 : 1}
            stroke="currentColor" strokeWidth={0.5} />
        ))}
        {/* EMA and price */}
        <polyline points={pt(ema)} fill="none" stroke="currentColor" className="text-text-secondary" strokeWidth={1.25} strokeDasharray="4 3" />
        <polyline points={pt(price)} fill="none" stroke="currentColor" className="text-text-primary" strokeWidth={1.5} />
        {/* markers */}
        <line x1={x(1)} y1={TOP - 8} x2={x(1)} y2={BOT + 6} stroke="currentColor" className="text-signal-bull" strokeWidth={1} />
        <text x={x(1) + 3} y={TOP - 2} fontSize={8} className="fill-current text-signal-bull">10-min bar closes → BUY alert</text>
        {touchIdx > 0 && (
          <g>
            <circle cx={x(touchIdx) + slot / 2} cy={TOP + price[touchIdx]} r={4} fill="currentColor" className="text-signal-bull" />
            <text x={x(touchIdx) + slot / 2 + 7} y={TOP + price[touchIdx] - 6} fontSize={8} className="fill-current text-signal-bull">touch → buy at this minute&apos;s option midpoint</text>
          </g>
        )}
        <text x={x(0) + slot / 2} y={BOT + 14} fontSize={8} textAnchor="middle" className="fill-current text-dim">before</text>
        <text x={x(1) + slot / 2} y={BOT + 14} fontSize={8} textAnchor="middle" className="fill-current text-text-secondary">alert bar</text>
        <text x={x(1) + slot / 2} y={BOT + 24} fontSize={8} textAnchor="middle" className="fill-current text-dim">let it close</text>
        {Array.from({ length: bars }, (_, i) => (
          <text key={i} x={x(i + 2) + slot / 2} y={BOT + 14} fontSize={8} textAnchor="middle" className="fill-current text-text-secondary">{`${(i + 1) * 2}m`}</text>
        ))}
        <text x={x(2) + (slot * bars) / 2} y={BOT + 24} fontSize={8} textAnchor="middle" className="fill-current text-text-secondary">{`${waitMin}-minute window: buy the first touch`}</text>
        <text x={x(bars + 2) + slot / 2} y={BOT + 14} fontSize={8} textAnchor="middle" className="fill-current text-dim">too late</text>
        <text x={x(bars + 2) + slot / 2} y={BOT + 24} fontSize={8} textAnchor="middle" className="fill-current text-dim">no touch = no trade</text>
        {/* legend */}
        <line x1={L} y1={H - 12} x2={L + 18} y2={H - 12} stroke="currentColor" className="text-text-primary" strokeWidth={1.5} />
        <text x={L + 22} y={H - 9} fontSize={8} className="fill-current text-text-secondary">SPY, 1-minute</text>
        <line x1={L + 100} y1={H - 12} x2={L + 118} y2={H - 12} stroke="currentColor" className="text-text-secondary" strokeWidth={1.25} strokeDasharray="4 3" />
        <text x={L + 122} y={H - 9} fontSize={8} className="fill-current text-text-secondary">{`${emaLen} EMA of 2-minute closes, last completed bar`}</text>
      </svg>
    </div>
  );
}

function ExitDiagram({ targetPct, stopPct }: { targetPct: number; stopPct: number }) {
  const W = 760, H = 170, L = 60, R = 200, TOP = 14, BOT = 140;
  const entry = 3.0;
  const target = entry * (1 + targetPct / 100), stop = entry * (1 - stopPct / 100);
  const lo = stop - 0.25, hi = target + 0.25;
  const y = (v: number) => TOP + ((hi - v) * (BOT - TOP)) / (hi - lo);
  const n = 26;
  const x = (i: number) => L + (i * (W - L - R)) / (n - 1);
  // a winning path and a losing path, in option dollars
  const win = [3.0, 2.96, 2.9, 2.94, 3.02, 3.1, 3.05, 3.16, 3.24, 3.3, 3.26, 3.38, 3.5, 3.58, 3.62];
  const lose = [3.0, 2.97, 2.9, 2.84, 2.88, 2.8, 2.76, 2.7];
  const path = (arr: number[]) => arr.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[720px]" role="img" aria-label="exit rules">
        {[["target", target, "text-signal-bull", `+${targetPct}%  ·  entry × ${(1 + targetPct / 100).toFixed(2)}`],
          ["entry", entry, "text-text-secondary", "entry (option midpoint at the touch)"],
          ["stop", stop, "text-signal-bear", `−${stopPct}%  ·  entry × ${(1 - stopPct / 100).toFixed(2)}`]].map(([k, v, cls, label]) => (
          <g key={k as string}>
            <line x1={L} y1={y(v as number)} x2={W - R} y2={y(v as number)} stroke="currentColor" className={cls as string}
              strokeWidth={k === "entry" ? 0.75 : 1.25} strokeDasharray={k === "entry" ? "2 3" : undefined} />
            <text x={L - 4} y={y(v as number) + 3} fontSize={8} textAnchor="end" className={`fill-current ${cls}`}>{(v as number).toFixed(2)}</text>
            <text x={W - R + 6} y={y(v as number) + 3} fontSize={8} className={`fill-current ${cls}`}>{label as string}</text>
          </g>
        ))}
        <polyline points={path(win)} fill="none" stroke="currentColor" className="text-signal-bull" strokeWidth={1.5} />
        <circle cx={x(win.length - 1)} cy={y(target)} r={3.5} fill="currentColor" className="text-signal-bull" />
        <text x={x(win.length - 1) + 6} y={y(target) - 6} fontSize={8} className="fill-current text-signal-bull">bar high reaches target → exit at the target</text>
        <polyline points={path(lose)} fill="none" stroke="currentColor" className="text-signal-bear" strokeWidth={1.5} />
        <circle cx={x(lose.length - 1)} cy={y(stop)} r={3.5} fill="currentColor" className="text-signal-bear" />
        <text x={x(lose.length - 1) + 6} y={y(stop) + 12} fontSize={8} className="fill-current text-signal-bear">bar low reaches stop → exit at the stop, checked first</text>
        <line x1={W - R - 2} y1={TOP} x2={W - R - 2} y2={BOT} stroke="currentColor" className="text-text-secondary" strokeWidth={1} strokeDasharray="3 3" />
        <text x={W - R - 6} y={BOT + 12} fontSize={8} textAnchor="end" className="fill-current text-text-secondary">15:59 ET: whatever is still open exits at the close</text>
        <text x={L} y={H - 4} fontSize={8} className="fill-current text-dim">Order inside every 1-minute bar: stop, then target (never in the entry minute), then the session close. One bar spanning both levels counts as a stop.</text>
      </svg>
    </div>
  );
}
