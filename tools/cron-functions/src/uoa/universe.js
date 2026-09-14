/**
 * The scan universe: 127 optionable US names.
 *
 * Carried over from the standalone UnusualOptions scanner's config, which built
 * it as the large-cap core plus the retail-heavy names where unusual flow
 * actually shows up (the "extras" tail below — MSTR, COIN, GME and friends).
 * Kept as source rather than a config blob so a change is reviewable in a diff.
 *
 * Size is a budget decision. Each symbol costs one expirations call plus one
 * chain call per in-window expiry, against Tradier's 120 requests a minute, so
 * this list sweeps in roughly three minutes. Adding a few hundred more names
 * would not fit the Consumption plan's ten-minute ceiling.
 */

"use strict";

const UNIVERSE = [
  "AAPL", "MSFT", "AMZN", "GOOGL", "GOOG", "META", "NVDA", "TSLA",
  "AVGO", "BRK.B", "JPM", "V", "MA", "UNH", "HD", "PG",
  "COST", "JNJ", "ABBV", "WMT", "NFLX", "CRM", "BAC", "KO",
  "PEP", "AMD", "TMO", "LIN", "ADBE", "MRK", "CSCO", "ACN",
  "MCD", "ABT", "DHR", "WFC", "TXN", "QCOM", "INTC", "INTU",
  "AMAT", "IBM", "GE", "CAT", "VZ", "NOW", "PM", "UBER",
  "SPGI", "AMGN", "ISRG", "PFE", "GS", "RTX", "HON", "NKE",
  "UNP", "T", "LOW", "COP", "BKNG", "PLD", "MS", "AXP",
  "ELV", "BLK", "SCHW", "LMT", "SYK", "DE", "BA", "MDT",
  "TJX", "ADP", "GILD", "MDLZ", "CB", "MMC", "VRTX", "CI",
  "REGN", "SBUX", "SO", "BMY", "PGR", "MU", "LRCX", "ZTS",
  "PYPL", "FCX", "F", "GM", "OXY", "FDX", "CMG", "DAL",
  "ON", "MRVL", "TTD", "DASH", "CRWD", "SNOW", "ZS", "DDOG",
  "TEAM", "WDAY", "ROKU", "ABNB", "RCL", "CCL", "WBD", "FANG",
  "MPC", "SLB", "XOM", "PLTR", "SMCI", "COIN", "MSTR", "GME",
  "AMC", "SOFI", "RIVN", "AFRM", "HOOD", "DKNG", "CVNA",
];

/**
 * Tradier spells a few tickers differently from everyone else. Class shares use
 * a slash, so BRK.B is BRK/B there and a dotted request silently returns no
 * quote at all rather than an error. The display name stays the familiar one.
 */
const FEED_SYMBOL = { "BRK.B": "BRK/B" };

const feedSymbol = (s) => FEED_SYMBOL[s] || s;

module.exports = { UNIVERSE, FEED_SYMBOL, feedSymbol };
