/**
 * Catalyst Value Equation (CVE) engine.
 *
 *   CVE = Magnitude × Speed
 *
 *   Magnitude — how big is the shift in perceived company value?
 *   Speed     — how fast must the market act on that shift?
 *
 * Each variable is rated Absolute / Yes / Maybe / No. The product of the two
 * ratings maps to a letter grade and a daily-stop allocation:
 *
 *   A+  Absolute × Absolute  → 80% of daily stop
 *   A   Yes × Yes            → 30%
 *   B   Yes × Maybe / M × Y  → 15%
 *   C   Maybe × Maybe        → minor allocation (5%)
 *   D   a "No" on either var  → 0% (filter out, do not trade)
 *
 * The combinations the spec leaves implicit (Absolute × Yes, Absolute × Maybe,
 * …) are filled in monotonically from the numeric product so the grade never
 * decreases when a rating improves. Rating values: Absolute 3, Yes 2, Maybe 1,
 * No 0.
 *
 * This module is PURE: no I/O. It takes a candidate (ticker + price move +
 * recent news) and returns a fully-scored CveResult, including a generated
 * commentary explaining why each rating was assigned. The classification is
 * deterministic and keyword-driven so every grade is explainable.
 */

export type Rating = "Absolute" | "Yes" | "Maybe" | "No";
export type CatalystType = "Fundamental" | "Technical" | "Combination" | "None";
export type Grade = "A+" | "A" | "B" | "C" | "D";
export type Direction = "positive" | "negative";

const RATING_VALUE: Record<Rating, number> = { Absolute: 3, Yes: 2, Maybe: 1, No: 0 };

export interface NewsItem {
  title: string;
  description: string;
  publishedUtc: string;
  url: string;
  publisher?: string;
  sentiment?: "positive" | "negative" | "neutral";
  sentimentReasoning?: string;
}

export interface CveCandidate {
  ticker: string;
  direction: Direction;
  changePct: number;
  price: number;
  volume: number;
  news: NewsItem[];
}

export interface RatingScore {
  rating: Rating;
  reason: string;
}

export interface CveResult {
  ticker: string;
  direction: Direction;
  changePct: number;
  price: number;
  catalystType: CatalystType;
  magnitude: RatingScore;
  speed: RatingScore;
  grade: Grade;
  stopPct: number;
  cve: number; // numeric Magnitude × Speed (0..9)
  commentary: string;
  headline: string;
  newsUrl: string;
  newsAgeHours: number | null;
}

// ─── Keyword dictionaries ────────────────────────────────────────────────────

const TECHNICAL_KW = [
  "added to the s&p", "added to s&p 500", "added to the nasdaq", "nasdaq-100",
  "nasdaq 100", "russell", "index inclusion", "index addition", "joins the s&p",
  "join the s&p", "index rebalanc", "rebalancing", "removed from the s&p",
  "index removal", "lockup", "lock-up", "lock up expir", "options listing",
  "stock split", "passive funds", "float increase", "reconstitution",
];

const FUNDAMENTAL_KW = [
  "earnings", "beats", "beat estimates", "tops estimates", "misses", "miss estimates",
  "revenue", "guidance", "fda", "approval", "approves", "rejects", "acquire",
  "acquisition", "merger", "buyout", "takeover", "to be acquired", "m&a",
  "upgrade", "downgrade", "price target", "initiates coverage", "analyst",
  "contract", "deal", "partnership", "recall", "lawsuit", "investigation",
  "probe", "clinical", "trial", "phase 3", "phase 2", "product", "launch",
  "dividend", "bankruptcy", "chapter 11", "delist", "warns", "guides",
  "settlement", "data readout", "label expansion", "fraud",
];

// Magnitude — POSITIVE direction.
const POS_ABSOLUTE = [
  "added to the s&p", "added to s&p 500", "joins the s&p", "join the s&p",
  "added to the nasdaq", "index inclusion", "index addition", "passive funds",
  "to be acquired", "to acquire", "all-cash acquisition", "buyout offer",
];
const POS_YES = [
  "fda approves", "fda approval", "approves", "beats", "tops estimates",
  "exceeds", "raises guidance", "raises full-year", "agrees to acquire",
  "acquires", "merger", "takeover", "wins contract", "awarded", "lands deal",
  "upgrades", "multiple upgrades", "raises price target", "initiates coverage with a buy",
  "positive data", "successful trial", "record revenue", "blowout",
];
const POS_MAYBE = [
  "reiterates", "maintains", "reaffirms", "in line", "in-line", "expands",
  "additional", "third", "another", "partnership", "collaboration",
  "extends", "renews", "modest", "incremental", "price target raised slightly",
];
// "Absence of an expected positive" — a positive-looking move with only weak,
// already-priced-in news. Scores Magnitude = No (→ D, filtered).
const POS_NO = [
  "delays", "postpones", "pushed back", "underwhelming", "disappoints",
  "below expectations", "fails to", "no update", "as expected", "priced in",
  "profit taking", "profit-taking", "technical bounce", "oversold bounce",
];

// Magnitude — NEGATIVE direction. A high grade requires a TRUE negative
// catalyst, not merely the absence of an expected positive (spec §5).
const NEG_ABSOLUTE = [
  "removed from the s&p", "index removal", "delisted", "delisting", "bankruptcy",
  "chapter 11", "fraud", "going concern", "ceo resigns amid", "accounting fraud",
];
const NEG_YES = [
  "misses", "miss estimates", "cuts guidance", "lowers guidance", "guides below",
  "slashes", "fda rejects", "rejection", "recall", "halts", "lawsuit", "sued",
  "investigation", "probe", "sec charges", "doj", "downgrade", "downgrades",
  "warns", "warning", "earnings miss", "trial failure", "failed trial",
  "discontinues", "withdraws guidance", "data breach", "plunges after",
];
const NEG_MAYBE = [
  "mixed results", "light guidance", "softer", "slightly below", "concerns",
  "cautious", "in-line but", "weaker", "headwinds", "margin pressure",
];
// Negative move but only "absence of positive" → No on Magnitude (→ D).
const NEG_NO = [
  "delays", "postpones", "underwhelming features", "disappointing rollout",
  "priced in", "profit taking", "profit-taking", "technical selloff",
  "rotation", "no catalyst", "valuation concerns", "broad market",
];

// Speed — hard mechanical deadline (funds legally obligated by a calendar date).
// Kept tight to index/tender mechanics: generic "deadline" matches class-action
// "lead plaintiff deadline" spam, so it is deliberately excluded.
const SPEED_ABSOLUTE = [
  "rebalanc", "rebalance date", "effective before the open", "effective at the close",
  "effective prior to", "index change effective", "will be added prior to",
  "added to the index effective", "tender offer expires", "tender offer deadline",
  "shares prior to the rebalance",
];
// Speed — slow digestion / multi-year horizon.
const SPEED_MAYBE = [
  "multi-year", "multiyear", "over the next", "over the coming", "long-term",
  "long term", "by 2030", "by 2031", "by 2032", "gradual", "phased", "ramp",
  "in the coming years", "over several years",
];

// ─── helpers ─────────────────────────────────────────────────────────────────

function corpus(news: NewsItem[]): string {
  return news
    .map((n) => `${n.title} ${n.description} ${n.sentimentReasoning ?? ""}`)
    .join("  ||  ")
    .toLowerCase();
}

function firstMatch(text: string, kws: string[]): string | null {
  for (const kw of kws) if (text.includes(kw)) return kw;
  return null;
}

function hoursSince(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 3_600_000;
}

// ─── classification ──────────────────────────────────────────────────────────

export function classifyCatalyst(news: NewsItem[]): CatalystType {
  if (news.length === 0) return "None";
  const text = corpus(news);
  const hasTech = TECHNICAL_KW.some((k) => text.includes(k));
  const hasFund = FUNDAMENTAL_KW.some((k) => text.includes(k));
  if (hasTech && hasFund) return "Combination";
  if (hasTech) return "Technical";
  if (hasFund) return "Fundamental";
  return "None";
}

export function scoreMagnitude(direction: Direction, news: NewsItem[]): RatingScore {
  if (news.length === 0) {
    return { rating: "No", reason: "no catalyzing news found — move is not backed by a value shift" };
  }
  const text = corpus(news);
  const [ABS, YES, MAYBE, NO] =
    direction === "positive"
      ? [POS_ABSOLUTE, POS_YES, POS_MAYBE, POS_NO]
      : [NEG_ABSOLUTE, NEG_YES, NEG_MAYBE, NEG_NO];

  const abs = firstMatch(text, ABS);
  if (abs) {
    return {
      rating: "Absolute",
      reason: direction === "positive"
        ? `structural, forced-flow catalyst ("${abs}") — an unambiguous repricing of company value`
        : `structural negative ("${abs}") — an unambiguous, forced repricing lower`,
    };
  }
  const yes = firstMatch(text, YES);
  // A confirmed, fresh real shift. Polygon sentiment that agrees reinforces it.
  if (yes) {
    return {
      rating: "Yes",
      reason: `confirmed ${direction === "positive" ? "real shift" : "true negative catalyst"} ("${yes}")`,
    };
  }
  const no = firstMatch(text, NO);
  const maybe = firstMatch(text, MAYBE);
  // Per spec §5: an "absence of an expected positive" must NOT outrank a true
  // catalyst. If the only matched signal is a NO-type phrase (and no Yes/Absolute),
  // grade it No even on a big move.
  if (no && !maybe) {
    return {
      rating: "No",
      reason: direction === "positive"
        ? `move reflects the absence of an expected positive ("${no}"), not a true catalyst — already priced in`
        : `decline is the absence of an expected positive ("${no}"), not a true negative event`,
    };
  }
  if (maybe) {
    return {
      rating: "Maybe",
      reason: `partial catalyst / confirmation of an existing thesis ("${maybe}") rather than a structural surprise`,
    };
  }
  // News exists and is on-theme but matches none of the tiered phrases — lean on
  // Polygon's per-ticker sentiment if it aligns with the price move.
  const aligned = news.some((n) =>
    direction === "positive" ? n.sentiment === "positive" : n.sentiment === "negative",
  );
  if (aligned) {
    return {
      rating: "Maybe",
      reason: `news sentiment aligns with the move but no confirmed structural catalyst — treat as a partial shift`,
    };
  }
  return {
    rating: "No",
    reason: `recent news does not corroborate a genuine ${direction} value shift`,
  };
}

export function scoreSpeed(
  magnitude: Rating,
  news: NewsItem[],
): RatingScore {
  if (news.length === 0) {
    return { rating: "No", reason: "no dated catalyst forcing the market to act on any timeline" };
  }
  const text = corpus(news);

  const abs = firstMatch(text, SPEED_ABSOLUTE);
  if (abs) {
    return {
      rating: "Absolute",
      reason: `a hard, mechanical deadline ("${abs}") — funds are obligated to act by a specific date`,
    };
  }

  // Freshness drives urgency when there is no legal deadline.
  const ages = news.map((n) => hoursSince(n.publishedUtc)).filter((h): h is number => h != null);
  const freshest = ages.length ? Math.min(...ages) : null;

  const slow = firstMatch(text, SPEED_MAYBE);
  if (slow) {
    return {
      rating: "Maybe",
      reason: `a slow-burn / multi-year horizon ("${slow}") — institutions digest it over days, not minutes`,
    };
  }

  // A fresh, real catalyst (Magnitude ≥ Yes) printed in the last ~30h demands
  // that institutions update models *today* — high urgency / snapback.
  if (RATING_VALUE[magnitude] >= 2 && freshest != null && freshest <= 30) {
    return {
      rating: "Yes",
      reason: `breaking catalyst (~${Math.round(freshest)}h old) — institutions must reprice today; high snapback potential`,
    };
  }
  if (freshest != null && freshest <= 72) {
    return {
      rating: "Maybe",
      reason: `catalyst is ${Math.round(freshest)}h old — being digested over days rather than forced in a session`,
    };
  }
  return {
    rating: "No",
    reason: freshest == null
      ? "no timeline on the news — repricing can drift over weeks"
      : `news is ${Math.round(freshest)}h old with no forced repricing — reassessed over weeks`,
  };
}

// ─── grade matrix ────────────────────────────────────────────────────────────

export function gradeFor(magnitude: Rating, speed: Rating): { grade: Grade; stopPct: number } {
  const product = RATING_VALUE[magnitude] * RATING_VALUE[speed];
  if (product === 0) return { grade: "D", stopPct: 0 };   // any "No"
  if (product >= 9) return { grade: "A+", stopPct: 80 };  // Absolute × Absolute
  if (product >= 4) return { grade: "A", stopPct: 30 };   // Yes × Yes, Absolute × Yes
  if (product >= 2) return { grade: "B", stopPct: 15 };   // Yes × Maybe, Absolute × Maybe
  return { grade: "C", stopPct: 5 };                      // Maybe × Maybe (minor)
}

// ─── commentary ──────────────────────────────────────────────────────────────

function buildCommentary(r: Omit<CveResult, "commentary">, headline: string): string {
  const move = `${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(1)}%`;
  const type = r.catalystType === "None" ? "no clear" : r.catalystType.toLowerCase();
  const head = headline ? ` — "${headline}"` : "";
  return (
    `${r.ticker} ${move} on a ${type} catalyst${head}. ` +
    `Magnitude = ${r.magnitude.rating}: ${r.magnitude.reason}. ` +
    `Speed = ${r.speed.rating}: ${r.speed.reason}. ` +
    `${r.magnitude.rating} × ${r.speed.rating} = ${r.grade}` +
    (r.grade === "D"
      ? " — filtered out (do not trade)."
      : `, suggesting ${r.stopPct}% of the daily stop.`)
  );
}

// ─── top-level evaluate ──────────────────────────────────────────────────────

export function evaluate(c: CveCandidate): CveResult {
  const catalystType = classifyCatalyst(c.news);
  const magnitude = scoreMagnitude(c.direction, c.news);
  const speed = scoreSpeed(magnitude.rating, c.news);
  const { grade, stopPct } = gradeFor(magnitude.rating, speed.rating);

  // Pick the most relevant headline: the freshest item whose sentiment aligns
  // with the move, else the freshest item overall.
  const sorted = [...c.news].sort(
    (a, b) => Date.parse(b.publishedUtc || "") - Date.parse(a.publishedUtc || ""),
  );
  const aligned = sorted.find((n) =>
    c.direction === "positive" ? n.sentiment === "positive" : n.sentiment === "negative",
  );
  const lead = aligned ?? sorted[0];
  const newsAgeHours = lead ? hoursSince(lead.publishedUtc) : null;

  const base: Omit<CveResult, "commentary"> = {
    ticker: c.ticker,
    direction: c.direction,
    changePct: c.changePct,
    price: c.price,
    catalystType,
    magnitude,
    speed,
    grade,
    stopPct,
    cve: RATING_VALUE[magnitude.rating] * RATING_VALUE[speed.rating],
    headline: lead?.title ?? "",
    newsUrl: lead?.url ?? "",
    newsAgeHours,
  };
  return { ...base, commentary: buildCommentary(base, lead?.title ?? "") };
}

/** Grades that clear the notification filter (B, A, A+ per spec §6). */
export const TRADEABLE_GRADES: ReadonlySet<Grade> = new Set<Grade>(["A+", "A", "B"]);

export function isTradeable(grade: Grade): boolean {
  return TRADEABLE_GRADES.has(grade);
}
