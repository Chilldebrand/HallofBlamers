/**
 * Shared display formatters for the history feature pages. Pure, no server
 * imports — safe to use from both server and client components.
 */

/** "9-5" or "9-5-1" — ties only shown when there are any. */
export function formatWLT(wins: number, losses: number, ties: number): string {
  return ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

/** Fraction (0..1) -> "58.6%". */
export function formatPct(value: number, decimals = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

/**
 * Fraction (0..1) -> baseball-style ".625" (no leading zero, 3 decimals) — the franchise
 * profile's stat-grid Win% cell specifically (Franchise.dc.html frames 9a/9b render career win
 * pct this way, distinct from the "62.5%" convention `formatPct` renders everywhere else in the
 * app, e.g. Standings/H2H). A value of 1 renders "1.000" (nothing to strip); values >= 0 only —
 * career win pct is never negative.
 */
export function formatWinPctBaseball(value: number): string {
  const fixed = value.toFixed(3);
  return fixed.startsWith("0.") ? fixed.slice(1) : fixed;
}

/** Whole-number, thousands-grouped -> "12,248". Career point totals in the franchise profile's
 * stat grid render this way (mockup: "12,248", not "12,248.4") — distinct from the
 * one-decimal convention (`toFixed(1)`) used for season-level point totals on the same page. */
export function formatWholeCommas(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** null-safe points formatter — never fabricates a 0 for missing data. */
export function formatPts(value: number | null | undefined, decimals = 1): string {
  return value === null || value === undefined ? "—" : value.toFixed(decimals);
}

/** null-safe efficiency formatter (fraction -> percent) — "—" for pre-2018 seasons. */
export function formatEfficiency(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : formatPct(value);
}

export function formatSigned(value: number, decimals = 1): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(decimals)}`;
}

const WEEK_TYPE_LABELS: Record<string, string> = {
  regular: "Reg",
  playoff: "Playoff",
  consolation: "Consolation",
  championship: "Championship",
};

/** Honest week-type badge text — 'consolation' reads as "Consolation", never hidden or relabeled. */
export function weekTypeLabel(weekType: string | null | undefined): string {
  if (!weekType) return "—";
  return WEEK_TYPE_LABELS[weekType] ?? weekType;
}

/** "2015 Wk16 – 2016 Wk1" or "2025 Wk17 – Present" for an ongoing reign. */
export function formatSpan(startSeason: number, startWeek: number, endSeason: number | null, endWeek: number | null): string {
  const start = `${startSeason} Wk${startWeek}`;
  if (endSeason === null || endWeek === null) return `${start} – Present`;
  return `${start} – ${endSeason} Wk${endWeek}`;
}

const END_REASON_LABELS: Record<string, string> = {
  lost: "Lost belt",
  vacated: "Vacated",
  override: "Commissioner override",
};

export function endReasonLabel(reason: string | null): string {
  if (!reason) return "Current";
  return END_REASON_LABELS[reason] ?? reason;
}

const PLAYOFF_TIER_LABELS: Record<string, string> = {
  WINNERS_BRACKET: "Bracket",
  WINNERS_CONSOLATION_LADDER: "Consolation",
  LOSERS_CONSOLATION_LADDER: "Consolation",
};

/** null for NONE/unset — callers skip the badge entirely rather than render an empty one. */
export function playoffTierLabel(tier: string | null): string | null {
  if (!tier || tier === "NONE") return null;
  return PLAYOFF_TIER_LABELS[tier] ?? tier;
}
