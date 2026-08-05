import { and, eq, inArray, or } from "drizzle-orm";
import type { RecordKey } from "@/engines";
import type { Db } from "@/server/db/client";
import {
  allplayWeek,
  appSettings,
  beltMatches,
  contextNotes,
  franchises,
  h2hPairs,
  matchups,
  players,
  recordEntries,
  rosterSlots,
  seasons,
  teamSeasons,
  teamWeek,
  transactionItems,
  transactions,
  weeks,
} from "@/server/db/schema";
import { computeAdvantage } from "@/server/queries/h2h";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by `buildWeekFacts` when the requested (season, week) either doesn't
 * exist in `weeks` at all, or exists but `isComplete` is false — a recap
 * needs a completed week's worth of results, never a partial/in-progress one.
 */
export class RecapIncompleteWeekError extends Error {
  readonly season: number;
  readonly week: number;

  constructor(season: number, week: number) {
    super(`Cannot build a recap for season ${season} week ${week}: that week is not complete yet.`);
    this.name = "RecapIncompleteWeekError";
    this.season = season;
    this.week = week;
  }
}

// ---------------------------------------------------------------------------
// Pure: standings snapshot w/ rank movement (unit-testable w/ plain arrays)
// ---------------------------------------------------------------------------

export interface StandingsSnapshotSourceRow {
  franchiseId: number;
  week: number;
  result: "W" | "L" | "T" | null;
  score: number;
}

interface StandingsAgg {
  franchiseId: number;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
}

function winPct(wins: number, losses: number, ties: number): number {
  const games = wins + losses + ties;
  return games > 0 ? (wins + 0.5 * ties) / games : 0;
}

/** Aggregates every row with `week <= throughWeek`, one entry per franchiseId. */
function aggregateStandingsThroughWeek(rows: StandingsSnapshotSourceRow[], throughWeek: number): StandingsAgg[] {
  const byFranchise = new Map<number, StandingsAgg>();
  for (const r of rows) {
    if (r.week > throughWeek || r.result === null) continue;
    const agg = byFranchise.get(r.franchiseId) ?? { franchiseId: r.franchiseId, wins: 0, losses: 0, ties: 0, pointsFor: 0 };
    if (r.result === "W") agg.wins += 1;
    else if (r.result === "L") agg.losses += 1;
    else agg.ties += 1;
    agg.pointsFor += r.score;
    byFranchise.set(r.franchiseId, agg);
  }
  return [...byFranchise.values()];
}

/** Win% desc, then points-for desc, then franchiseId asc (deterministic tiebreak) — same ordering
 * convention as `sortRealStandings`'s incomplete-season branch. Returns 1-based ranks. */
function rankStandings(rows: StandingsAgg[]): (StandingsAgg & { rank: number })[] {
  const sorted = [...rows].sort((a, b) => {
    const pctDiff = winPct(b.wins, b.losses, b.ties) - winPct(a.wins, a.losses, a.ties);
    if (pctDiff !== 0) return pctDiff;
    const ptsDiff = b.pointsFor - a.pointsFor;
    if (ptsDiff !== 0) return ptsDiff;
    return a.franchiseId - b.franchiseId;
  });
  return sorted.map((r, i) => ({ ...r, rank: i + 1 }));
}

export interface StandingsSnapshotEntry {
  franchiseId: number;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  rank: number;
  /** priorRank - currentRank: positive = moved up, negative = moved down. Null on week 1 (no prior
   * week exists) or when the franchise has no rows before this week (shouldn't happen for an
   * active franchise, but never fabricated as 0). */
  rankMovement: number | null;
}

/**
 * Standings as of `week` (cumulative through that week), each row's rank movement vs its rank as
 * of `week - 1`. Pure — unit-tested directly with fixture rows; `buildWeekFacts` supplies real
 * team_week rows. Deliberately NOT `standings.ts`'s `getStandingsReal` (that computes season-
 * final/season-to-date from `team_seasons`, not "as of week N").
 */
export function computeStandingsSnapshot(rows: StandingsSnapshotSourceRow[], week: number): StandingsSnapshotEntry[] {
  const current = rankStandings(aggregateStandingsThroughWeek(rows, week));
  const prior = week > 1 ? rankStandings(aggregateStandingsThroughWeek(rows, week - 1)) : null;
  const priorRankById = new Map((prior ?? []).map((p) => [p.franchiseId, p.rank]));

  return current.map((c) => {
    const priorRank = priorRankById.get(c.franchiseId);
    return {
      franchiseId: c.franchiseId,
      wins: c.wins,
      losses: c.losses,
      ties: c.ties,
      pointsFor: c.pointsFor,
      rank: c.rank,
      rankMovement: priorRank !== undefined ? priorRank - c.rank : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Pure: week superlatives (top/low score, closest, blowout, bench disaster,
// luckiest win, best efficiency)
// ---------------------------------------------------------------------------

export interface SuperlativeTeamWeekLike {
  franchiseId: number;
  opponentFranchiseId: number | null;
  score: number;
  margin: number | null;
  result: "W" | "L" | "T" | null;
  benchPointsLeft: number | null;
  efficiency: number | null;
}

export interface SuperlativeAllplayLike {
  franchiseId: number;
  luckScore: number | null;
}

export interface FactsSuperlativesIds {
  topScore: { franchiseId: number; value: number } | null;
  lowScore: { franchiseId: number; value: number } | null;
  closest: { franchiseIdA: number; franchiseIdB: number; margin: number } | null;
  blowout: { winnerFranchiseId: number; loserFranchiseId: number; margin: number } | null;
  /** Task 17 — "Beatdown of the Week": the largest losing margin (most negative), LOSER-
   * attributed — the shame side of `blowout`, so the recap model can roast it. */
  beatdown: { franchiseId: number; opponentFranchiseId: number; margin: number } | null;
  /** Max benchPointsLeft across the week. */
  benchDisaster: { franchiseId: number; value: number } | null;
  /** Highest luckScore among franchises that WON this week. */
  luckiestWin: { franchiseId: number; luckScore: number } | null;
  bestEfficiency: { franchiseId: number; value: number } | null;
}

/** Pure — unit-tested directly against fixture rows. */
export function computeWeekSuperlativeIds(teamWeeks: SuperlativeTeamWeekLike[], allplay: SuperlativeAllplayLike[]): FactsSuperlativesIds {
  const played = teamWeeks.filter((r) => r.result !== null);

  let topScore: FactsSuperlativesIds["topScore"] = null;
  let lowScore: FactsSuperlativesIds["lowScore"] = null;
  for (const r of played) {
    if (!topScore || r.score > topScore.value) topScore = { franchiseId: r.franchiseId, value: r.score };
    if (!lowScore || r.score < lowScore.value) lowScore = { franchiseId: r.franchiseId, value: r.score };
  }

  const wins = played.filter((r) => r.result === "W" && r.margin !== null && r.opponentFranchiseId !== null);
  let blowout: FactsSuperlativesIds["blowout"] = null;
  let closest: FactsSuperlativesIds["closest"] = null;
  for (const r of wins) {
    const margin = r.margin!;
    if (!blowout || margin > blowout.margin) blowout = { winnerFranchiseId: r.franchiseId, loserFranchiseId: r.opponentFranchiseId!, margin };
    if (!closest || margin < closest.margin) closest = { franchiseIdA: r.franchiseId, franchiseIdB: r.opponentFranchiseId!, margin };
  }

  const losses = played.filter((r) => r.result === "L" && r.margin !== null && r.opponentFranchiseId !== null);
  let beatdown: FactsSuperlativesIds["beatdown"] = null;
  for (const r of losses) {
    const margin = r.margin!;
    if (!beatdown || margin < beatdown.margin) beatdown = { franchiseId: r.franchiseId, opponentFranchiseId: r.opponentFranchiseId!, margin };
  }

  let benchDisaster: FactsSuperlativesIds["benchDisaster"] = null;
  for (const r of played) {
    if (r.benchPointsLeft === null) continue;
    if (!benchDisaster || r.benchPointsLeft > benchDisaster.value) benchDisaster = { franchiseId: r.franchiseId, value: r.benchPointsLeft };
  }

  const allplayByFranchise = new Map(allplay.map((a) => [a.franchiseId, a]));
  let luckiestWin: FactsSuperlativesIds["luckiestWin"] = null;
  for (const r of wins) {
    const a = allplayByFranchise.get(r.franchiseId);
    if (!a || a.luckScore === null) continue;
    if (!luckiestWin || a.luckScore > luckiestWin.luckScore) luckiestWin = { franchiseId: r.franchiseId, luckScore: a.luckScore };
  }

  let bestEfficiency: FactsSuperlativesIds["bestEfficiency"] = null;
  for (const r of played) {
    if (r.efficiency === null) continue;
    if (!bestEfficiency || r.efficiency > bestEfficiency.value) bestEfficiency = { franchiseId: r.franchiseId, value: r.efficiency };
  }

  return { topScore, lowScore, closest, blowout, beatdown, benchDisaster, luckiestWin, bestEfficiency };
}

// ---------------------------------------------------------------------------
// Pure: transactions — zero-item TRADE_UPHOLD phantom exclusion, week scoping
// ---------------------------------------------------------------------------

export interface TransactionLike {
  id: number;
  type: "waiver" | "freeagent" | "trade" | "drop" | "lineup";
  rawJson: unknown;
}

/** `transactions.rawJson.scoringPeriodId` maps 1:1 to `weeks.scoringPeriodId` for a given season —
 * the only path to "this week's transactions" (transactions has no direct week column). Pure. */
export function filterTransactionsByScoringPeriod(txs: TransactionLike[], scoringPeriodId: number): TransactionLike[] {
  return txs.filter((t) => {
    const raw = t.rawJson as { scoringPeriodId?: unknown } | null | undefined;
    return typeof raw?.scoringPeriodId === "number" && raw.scoringPeriodId === scoringPeriodId;
  });
}

/**
 * Excludes zero-item `trade`-typed rows — real data confirms these are ESPN "TRADE_UPHOLD" phantom
 * rows (46 vs 13 real trades with items), never a real trade. Non-trade rows always pass through.
 * Pure.
 */
export function excludeZeroItemTrades(txs: TransactionLike[], itemCountByTxId: Map<number, number>): TransactionLike[] {
  return txs.filter((t) => t.type !== "trade" || (itemCountByTxId.get(t.id) ?? 0) > 0);
}

// ---------------------------------------------------------------------------
// Pure: playoff picture ("within 1 game of the cut")
// ---------------------------------------------------------------------------

export interface PlayoffCutlineEntry {
  franchiseId: number;
  franchiseName: string;
  wins: number;
  losses: number;
  ties: number;
  rank: number;
}

/** Standard "games back" formula, ties counted as half a win/half a loss (matches `winPct`
 * elsewhere). Positive = `team` trails `anchor`; negative = `team` leads `anchor`; 0 = tied. Pure. */
export function computeGamesBack(
  anchor: { wins: number; losses: number; ties: number },
  team: { wins: number; losses: number; ties: number },
): number {
  const anchorW = anchor.wins + anchor.ties * 0.5;
  const anchorL = anchor.losses + anchor.ties * 0.5;
  const teamW = team.wins + team.ties * 0.5;
  const teamL = team.losses + team.ties * 0.5;
  return (anchorW - teamW + (teamL - anchorL)) / 2;
}

function formatRecord(t: { wins: number; losses: number; ties: number }): string {
  return `${t.wins}-${t.losses}${t.ties > 0 ? `-${t.ties}` : ""}`;
}

function formatGamesBack(gb: number): string {
  const abs = Math.abs(gb);
  return abs % 1 === 0 ? String(abs) : abs.toFixed(1);
}

/**
 * One sentence per team within 1 game of the playoff cutline — `standings` MUST already be ranked
 * (see `computeStandingsSnapshot`/`rankStandings`). Returns `[]` when `playoffTeamCount` doesn't
 * carve a real boundary out of the field (<=0 or >= every team made it). Pure.
 */
export function computePlayoffPictureSentences(standings: PlayoffCutlineEntry[], playoffTeamCount: number): string[] {
  if (playoffTeamCount <= 0 || playoffTeamCount >= standings.length) return [];
  const cutTeam = standings.find((s) => s.rank === playoffTeamCount);
  if (!cutTeam) return [];

  const sentences: string[] = [];
  for (const team of standings) {
    const gb = computeGamesBack(cutTeam, team);
    if (Math.abs(gb) > 1) continue;
    const record = formatRecord(team);
    if (team.rank <= playoffTeamCount) {
      sentences.push(
        gb === 0
          ? `${team.franchiseName} holds the No. ${team.rank} seed at ${record}, right on the cutline.`
          : `${team.franchiseName} holds the No. ${team.rank} seed at ${record}, ${formatGamesBack(gb)} game${Math.abs(gb) === 1 ? "" : "s"} clear of the cut.`,
      );
    } else {
      sentences.push(
        `${team.franchiseName} sits at ${record}, ${formatGamesBack(gb)} game${Math.abs(gb) === 1 ? "" : "s"} behind the final playoff spot.`,
      );
    }
  }
  return sentences;
}

// ---------------------------------------------------------------------------
// Assembled facts JSON shape
// ---------------------------------------------------------------------------

export interface FactsMeta {
  season: number;
  week: number;
  weekType: "regular" | "playoff" | "consolation" | "championship";
  scoringPeriodId: number;
  /**
   * No calendar date for a given (season, week) exists ANYWHERE in this schema — `weeks` carries
   * only season/week/scoringPeriodId/weekType/isComplete (confirmed against schema.ts). Rather than
   * fabricate one, this field is intentionally absent; the recap prose refers to weeks by number,
   * consistent with the project's "never fabricate" rule (finalStanding=0 placeholders, sentinel
   * player ids, pre-2018 "no lineup data" states are all handled the same honest way elsewhere).
   */
  /**
   * Null for a regular-season week. A short label for any non-regular week (real data only ever
   * uses "playoff", never "consolation"/"championship", but all three get a label defensively) —
   * gives the model framing for why standings/playoff_picture look frozen (fix round 1, I3).
   */
  bracket: string | null;
}

export interface FactsStandingsRow {
  franchiseId: number;
  franchiseName: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  rank: number;
  rankMovement: number | null;
}

export interface FactsPerformer {
  playerName: string;
  franchiseName: string;
  points: number;
}

export interface FactsMatchupSide {
  franchiseId: number;
  franchiseName: string;
  score: number;
  projected: number | null;
  benchPointsLeft: number | null;
}

export interface FactsBelt {
  atStake: true;
  result: "defense" | "transfer";
  holderName: string;
  challengerName: string;
}

export interface FactsMatchup {
  matchupId: number;
  home: FactsMatchupSide;
  away: FactsMatchupSide | null;
  isFinal: boolean;
  margin: number | null;
  topPerformers: FactsPerformer[];
  h2hAfter: string | null;
  contextNotes: string[];
  belt: FactsBelt | null;
}

export interface FactsSuperlativeScore {
  franchiseName: string;
  value: number;
}

export interface FactsSuperlativeMatchup {
  winnerName: string;
  loserName: string;
  margin: number;
}

/** Task 17 — "Beatdown of the Week", loser-attributed (the brief's own field trio: franchise,
 * margin, opponent) so the recap model has exactly who lost, by how much, and to whom. */
export interface FactsSuperlativeBeatdown {
  franchiseName: string;
  opponentName: string;
  margin: number;
}

export interface FactsSuperlatives {
  topScore: FactsSuperlativeScore | null;
  lowScore: FactsSuperlativeScore | null;
  closest: FactsSuperlativeMatchup | null;
  blowout: FactsSuperlativeMatchup | null;
  beatdown: FactsSuperlativeBeatdown | null;
  benchDisaster: FactsSuperlativeScore | null;
  luckiestWin: { franchiseName: string; luckScore: number } | null;
  bestEfficiency: FactsSuperlativeScore | null;
}

export interface FactsRecordBroken {
  franchiseName: string | null;
  text: string;
}

export interface FactsRecordApproached {
  recordKey: RecordKey;
  rank: number;
  franchiseName: string;
  value: number;
}

export interface FactsTradeSide {
  franchiseName: string;
  sent: string[];
  received: string[];
}

export interface FactsTrade {
  franchises: FactsTradeSide[];
}

export interface FactsNotableAdd {
  franchiseName: string;
  playerName: string;
  points: number;
}

export interface WeekFacts {
  meta: FactsMeta;
  standings: FactsStandingsRow[];
  matchups: FactsMatchup[];
  superlatives: FactsSuperlatives;
  records: {
    broken: FactsRecordBroken[];
    approached: FactsRecordApproached[];
  };
  transactions: {
    trades: FactsTrade[];
    notableAdds: FactsNotableAdd[];
  };
  /** Null when the season has fewer than 5 completed weeks through this one — omitted, not an
   * empty array, so the prompt/UI can tell "not eligible yet" apart from "nobody's close". */
  playoffPicture: string[] | null;
  commissionerNotes: string | null;
}

interface H2HPairRowLike {
  franchiseA: number;
  franchiseB: number;
  regW: number;
  regL: number;
  regT: number;
  playoffW: number;
  playoffL: number;
  playoffT: number;
}

/** "This week's game leaves the series at..." one-liner from an ALREADY-FETCHED h2h_pairs row —
 * pure, reuses only the PURE `computeAdvantage` helper (never `queries/h2h.ts`'s
 * `getH2HPairDetail`, which reads through the module-level `getDb()` singleton — using it here
 * would silently read a DIFFERENT database than the one this function was given, breaking test
 * isolation against a temp DB and, in production, being a redundant second connection to the same
 * file). */
function formatH2HAfterLine(pair: H2HPairRowLike, nameOf: (id: number) => string): string {
  const wins = pair.regW + pair.playoffW;
  const losses = pair.regL + pair.playoffL;
  const ties = pair.regT + pair.playoffT;
  const advantage = computeAdvantage(wins, losses);
  if (advantage === "even") return `Series tied ${wins}-${losses}${ties > 0 ? `-${ties}` : ""} all-time.`;

  const leaderName = advantage === "leading" ? nameOf(pair.franchiseA) : nameOf(pair.franchiseB);
  const leaderWins = advantage === "leading" ? wins : losses;
  const leaderLosses = advantage === "leading" ? losses : wins;
  return `${leaderName} leads the all-time series ${leaderWins}-${leaderLosses}${ties > 0 ? `-${ties}` : ""}.`;
}

/** Batches every h2h_pairs row that could be relevant to this week's matchups in ONE query
 * (fix round 1 minor — was one query per matchup), keyed by "lo:hi" for O(1) lookup. Mirrors the
 * file's other `inArray`-batched joins (belt/notes below). */
function fetchH2HPairsForFranchises(db: Db, franchiseIds: number[]): Map<string, H2HPairRowLike> {
  if (franchiseIds.length === 0) return new Map();
  const rows = db
    .select()
    .from(h2hPairs)
    .where(or(inArray(h2hPairs.franchiseA, franchiseIds), inArray(h2hPairs.franchiseB, franchiseIds)))
    .all();
  return new Map(rows.map((p) => [`${p.franchiseA}:${p.franchiseB}`, p]));
}

/** A short, honest label for a non-regular-season week — null for "regular" (the standard case).
 * Real data only ever uses "playoff" for every post-regular-season week (confirmed against every
 * archived season), but "consolation"/"championship" are handled too since the schema allows them
 * — never assume only one non-regular value can occur. */
function describeBracket(weekType: FactsMeta["weekType"]): string | null {
  switch (weekType) {
    case "regular":
      return null;
    case "playoff":
      return "playoff bracket";
    case "consolation":
      return "consolation bracket";
    case "championship":
      return "championship week";
  }
}

/** Highest `week` among this season's `weekType='regular'` rows, or null if none exist (shouldn't
 * happen for a season with any completed week, but never assumed). */
function getLastRegularSeasonWeek(db: Db, season: number): number | null {
  const rows = db
    .select({ week: weeks.week })
    .from(weeks)
    .where(and(eq(weeks.season, season), eq(weeks.weekType, "regular")))
    .all();
  if (rows.length === 0) return null;
  return Math.max(...rows.map((r) => r.week));
}

// ---------------------------------------------------------------------------
// buildWeekFacts — orchestrates the DB reads + the pure functions above
// ---------------------------------------------------------------------------

const NOTABLE_ADD_THRESHOLD = 15;

export function buildWeekFacts(db: Db, season: number, week: number): WeekFacts {
  const weekRow = db.select().from(weeks).where(and(eq(weeks.season, season), eq(weeks.week, week))).get();
  if (!weekRow || !weekRow.isComplete) throw new RecapIncompleteWeekError(season, week);

  const franchiseRows = db.select({ id: franchises.id, name: franchises.canonicalName }).from(franchises).all();
  const nameById = new Map(franchiseRows.map((f) => [f.id, f.name]));
  const nameOf = (id: number) => nameById.get(id) ?? "—";

  const teamSeasonRows = db.select().from(teamSeasons).where(eq(teamSeasons.season, season)).all();
  const franchiseIdByTeamSeasonId = new Map(teamSeasonRows.map((t) => [t.id, t.franchiseId]));

  // --- standings snapshot ---------------------------------------------------
  // Fix round 1, I3: bracket games are single-elimination, not standings-additive — folding a
  // playoff win/loss into the regular-season W-L record produced a real, reviewer-caught defect
  // (2025 wk17: naive cumulative-through-week-17 showed Bills Mafia Don 14-2; the real record,
  // ESPN's own team_seasons.wins/losses AND every regular-season-only recount, is 13-1). Two-part
  // fix: (a) restrict the source rows to weekType='regular' ONLY, so a bracket game can never be
  // counted; (b) for a non-regular target week, freeze the snapshot at the season's LAST regular
  // week rather than "through week N" (a playoff week number has no meaning as a regular-season
  // cutoff) — both the current AND prior snapshots freeze there, so movement reflects the same
  // shakeout a recap of that last regular week would have shown, not something mid-bracket.
  const bracket = describeBracket(weekRow.weekType);
  const standingsAsOfWeek = weekRow.weekType === "regular" ? week : (getLastRegularSeasonWeek(db, season) ?? week);
  const seasonTeamWeekRows = db
    .select({ franchiseId: teamWeek.franchiseId, week: teamWeek.week, result: teamWeek.result, score: teamWeek.score })
    .from(teamWeek)
    .where(and(eq(teamWeek.season, season), eq(teamWeek.weekType, "regular")))
    .all();
  const standingsSnapshot = computeStandingsSnapshot(seasonTeamWeekRows, standingsAsOfWeek).sort((a, b) => a.rank - b.rank);
  const standings: FactsStandingsRow[] = standingsSnapshot.map((s) => ({ ...s, franchiseName: nameOf(s.franchiseId) }));

  // --- this week's team_week + allplay_week rows --------------------------
  const thisWeekTeamWeekRows = db.select().from(teamWeek).where(and(eq(teamWeek.season, season), eq(teamWeek.week, week))).all();
  const teamWeekByFranchise = new Map(thisWeekTeamWeekRows.map((r) => [r.franchiseId, r]));
  const allplayRows = db.select().from(allplayWeek).where(and(eq(allplayWeek.season, season), eq(allplayWeek.week, week))).all();

  const superlativeIds = computeWeekSuperlativeIds(
    thisWeekTeamWeekRows.map((r) => ({
      franchiseId: r.franchiseId,
      opponentFranchiseId: r.opponentFranchiseId,
      score: r.score,
      margin: r.margin,
      result: r.result,
      benchPointsLeft: r.benchPointsLeft,
      efficiency: r.efficiency,
    })),
    allplayRows.map((r) => ({ franchiseId: r.franchiseId, luckScore: r.luckScore })),
  );
  const superlatives: FactsSuperlatives = {
    topScore: superlativeIds.topScore ? { franchiseName: nameOf(superlativeIds.topScore.franchiseId), value: superlativeIds.topScore.value } : null,
    lowScore: superlativeIds.lowScore ? { franchiseName: nameOf(superlativeIds.lowScore.franchiseId), value: superlativeIds.lowScore.value } : null,
    closest: superlativeIds.closest
      ? { winnerName: nameOf(superlativeIds.closest.franchiseIdA), loserName: nameOf(superlativeIds.closest.franchiseIdB), margin: superlativeIds.closest.margin }
      : null,
    blowout: superlativeIds.blowout
      ? { winnerName: nameOf(superlativeIds.blowout.winnerFranchiseId), loserName: nameOf(superlativeIds.blowout.loserFranchiseId), margin: superlativeIds.blowout.margin }
      : null,
    beatdown: superlativeIds.beatdown
      ? { franchiseName: nameOf(superlativeIds.beatdown.franchiseId), opponentName: nameOf(superlativeIds.beatdown.opponentFranchiseId), margin: superlativeIds.beatdown.margin }
      : null,
    benchDisaster: superlativeIds.benchDisaster
      ? { franchiseName: nameOf(superlativeIds.benchDisaster.franchiseId), value: superlativeIds.benchDisaster.value }
      : null,
    luckiestWin: superlativeIds.luckiestWin
      ? { franchiseName: nameOf(superlativeIds.luckiestWin.franchiseId), luckScore: superlativeIds.luckiestWin.luckScore }
      : null,
    bestEfficiency: superlativeIds.bestEfficiency
      ? { franchiseName: nameOf(superlativeIds.bestEfficiency.franchiseId), value: superlativeIds.bestEfficiency.value }
      : null,
  };

  // --- per-matchup facts ----------------------------------------------------
  const matchupRows = db.select().from(matchups).where(and(eq(matchups.season, season), eq(matchups.week, week))).all();
  const matchupIds = matchupRows.map((m) => m.id);

  const beltRows = matchupIds.length > 0 ? db.select().from(beltMatches).where(inArray(beltMatches.matchupId, matchupIds)).all() : [];
  const beltByMatchup = new Map(beltRows.map((b) => [b.matchupId, b]));

  const noteRowsByMatchup = matchupIds.length > 0 ? db.select().from(contextNotes).where(inArray(contextNotes.matchupId, matchupIds)).all() : [];
  const notesByMatchup = new Map<number, typeof noteRowsByMatchup>();
  for (const n of noteRowsByMatchup) {
    if (n.matchupId === null) continue;
    const list = notesByMatchup.get(n.matchupId) ?? [];
    list.push(n);
    notesByMatchup.set(n.matchupId, list);
  }

  // Unfiltered by teamSeasonId — every roster slot for this (season, week) across the whole
  // league, so it doubles as the source for both per-matchup top performers AND notable-adds'
  // points lookup below (no per-item DB round-trip needed).
  const rosterRows = db
    .select({
      teamSeasonId: rosterSlots.teamSeasonId,
      playerId: rosterSlots.playerId,
      points: rosterSlots.points,
      playerName: players.fullName,
    })
    .from(rosterSlots)
    .innerJoin(players, eq(rosterSlots.playerId, players.espnPlayerId))
    .where(and(eq(rosterSlots.season, season), eq(rosterSlots.week, week)))
    .all();
  const rosterByTeamSeason = new Map<number, typeof rosterRows>();
  const pointsByTeamSeasonAndPlayer = new Map<string, number | null>();
  for (const r of rosterRows) {
    const list = rosterByTeamSeason.get(r.teamSeasonId) ?? [];
    list.push(r);
    rosterByTeamSeason.set(r.teamSeasonId, list);
    pointsByTeamSeasonAndPlayer.set(`${r.teamSeasonId}:${r.playerId}`, r.points);
  }

  const involvedFranchiseIds = [
    ...new Set(
      matchupRows.flatMap((m) => {
        const home = franchiseIdByTeamSeasonId.get(m.homeTeamSeasonId)!;
        const away = m.awayTeamSeasonId !== null ? franchiseIdByTeamSeasonId.get(m.awayTeamSeasonId) : undefined;
        return away !== undefined ? [home, away] : [home];
      }),
    ),
  ];
  const h2hPairByKey = fetchH2HPairsForFranchises(db, involvedFranchiseIds);

  const matchupFacts: FactsMatchup[] = matchupRows.map((m) => {
    const homeFranchiseId = franchiseIdByTeamSeasonId.get(m.homeTeamSeasonId)!;
    const awayFranchiseId = m.awayTeamSeasonId !== null ? franchiseIdByTeamSeasonId.get(m.awayTeamSeasonId) : undefined;

    const homeTW = teamWeekByFranchise.get(homeFranchiseId);
    const awayTW = awayFranchiseId !== undefined ? teamWeekByFranchise.get(awayFranchiseId) : undefined;

    const home: FactsMatchupSide = {
      franchiseId: homeFranchiseId,
      franchiseName: nameOf(homeFranchiseId),
      score: m.homeScore,
      projected: m.homeProjected,
      benchPointsLeft: homeTW?.benchPointsLeft ?? null,
    };
    const away: FactsMatchupSide | null =
      awayFranchiseId !== undefined
        ? {
            franchiseId: awayFranchiseId,
            franchiseName: nameOf(awayFranchiseId),
            score: m.awayScore,
            projected: m.awayProjected,
            benchPointsLeft: awayTW?.benchPointsLeft ?? null,
          }
        : null;

    const combinedRoster = [
      ...(rosterByTeamSeason.get(m.homeTeamSeasonId) ?? []),
      ...(m.awayTeamSeasonId !== null ? (rosterByTeamSeason.get(m.awayTeamSeasonId) ?? []) : []),
    ];
    const topPerformers: FactsPerformer[] = combinedRoster
      .filter((r): r is typeof r & { points: number } => r.points !== null)
      .sort((a, b) => b.points - a.points)
      .slice(0, 3)
      .map((r) => ({
        playerName: r.playerName,
        franchiseName: nameOf(franchiseIdByTeamSeasonId.get(r.teamSeasonId)!),
        points: r.points,
      }));

    const h2hAfter = away
      ? (() => {
          const lo = Math.min(home.franchiseId, away.franchiseId);
          const hi = Math.max(home.franchiseId, away.franchiseId);
          const pair = h2hPairByKey.get(`${lo}:${hi}`);
          return pair ? formatH2HAfterLine(pair, nameOf) : null;
        })()
      : null;

    const beltRow = beltByMatchup.get(m.id);
    const belt: FactsBelt | null = beltRow
      ? { atStake: true, result: beltRow.result, holderName: nameOf(beltRow.holderFranchiseId), challengerName: nameOf(beltRow.challengerFranchiseId) }
      : null;

    const notes = (notesByMatchup.get(m.id) ?? []).slice().sort((a, b) => b.salience - a.salience || a.ruleId.localeCompare(b.ruleId) || a.id - b.id);

    return {
      matchupId: m.id,
      home,
      away,
      isFinal: m.isFinal,
      margin: away ? Math.abs(m.homeScore - m.awayScore) : null,
      topPerformers,
      h2hAfter,
      contextNotes: notes.slice(0, 3).map((n) => n.renderedText),
      belt,
    };
  });

  // --- records: broken (context_notes record_broken) + approached (top-3 record_entries) --------
  const brokenNoteRows = db
    .select({ franchiseId: contextNotes.franchiseId, renderedText: contextNotes.renderedText })
    .from(contextNotes)
    .where(and(eq(contextNotes.season, season), eq(contextNotes.week, week), eq(contextNotes.ruleId, "record_broken")))
    .all();
  const broken: FactsRecordBroken[] = brokenNoteRows.map((r) => ({
    franchiseName: r.franchiseId !== null ? nameOf(r.franchiseId) : null,
    text: r.renderedText,
  }));

  const approachedRows = db
    .select({ recordKey: recordEntries.recordKey, rank: recordEntries.rank, franchiseId: recordEntries.franchiseId, value: recordEntries.value })
    .from(recordEntries)
    .where(and(eq(recordEntries.season, season), eq(recordEntries.week, week)))
    .all()
    .filter((r) => r.rank <= 3);
  const approached: FactsRecordApproached[] = approachedRows.map((r) => ({
    recordKey: r.recordKey as RecordKey,
    rank: r.rank,
    franchiseName: nameOf(r.franchiseId),
    value: r.value,
  }));

  // --- transactions this week ----------------------------------------------
  const seasonTxRows = db.select().from(transactions).where(eq(transactions.season, season)).all();
  const weekTxRows = filterTransactionsByScoringPeriod(seasonTxRows, weekRow.scoringPeriodId);
  const weekTxIds = weekTxRows.map((t) => t.id);

  const itemRows = weekTxIds.length > 0 ? db.select().from(transactionItems).where(inArray(transactionItems.transactionId, weekTxIds)).all() : [];
  const itemsByTx = new Map<number, typeof itemRows>();
  for (const item of itemRows) {
    const list = itemsByTx.get(item.transactionId) ?? [];
    list.push(item);
    itemsByTx.set(item.transactionId, list);
  }
  const itemCountByTxId = new Map<number, number>([...itemsByTx.entries()].map(([txId, items]) => [txId, items.length]));
  const realWeekTxRows = excludeZeroItemTrades(weekTxRows, itemCountByTxId);

  const playerIds = [...new Set(itemRows.map((i) => i.playerId))];
  const playerRows = playerIds.length > 0 ? db.select().from(players).where(inArray(players.espnPlayerId, playerIds)).all() : [];
  const playerNameById = new Map(playerRows.map((p) => [p.espnPlayerId, p.fullName]));
  const playerNameOf = (id: number) => playerNameById.get(id) ?? `Player ${id}`;

  const trades: FactsTrade[] = realWeekTxRows
    .filter((t) => t.type === "trade")
    .map((t) => {
      const items = itemsByTx.get(t.id) ?? [];
      const byTeamSeason = new Map<number, { sent: string[]; received: string[] }>();
      for (const item of items) {
        const entry = byTeamSeason.get(item.teamSeasonId) ?? { sent: [], received: [] };
        if (item.action === "trade_away") entry.sent.push(playerNameOf(item.playerId));
        else if (item.action === "trade_for") entry.received.push(playerNameOf(item.playerId));
        byTeamSeason.set(item.teamSeasonId, entry);
      }
      const franchisesInTrade: FactsTradeSide[] = [...byTeamSeason.entries()].map(([teamSeasonId, sides]) => ({
        franchiseName: nameOf(franchiseIdByTeamSeasonId.get(teamSeasonId) ?? -1),
        sent: sides.sent,
        received: sides.received,
      }));
      return { franchises: franchisesInTrade };
    });

  const notableAdds: FactsNotableAdd[] = [];
  for (const t of realWeekTxRows) {
    if (t.type !== "waiver" && t.type !== "freeagent") continue;
    for (const item of itemsByTx.get(t.id) ?? []) {
      if (item.action !== "add") continue;
      const points = pointsByTeamSeasonAndPlayer.get(`${item.teamSeasonId}:${item.playerId}`);
      if (points !== null && points !== undefined && points >= NOTABLE_ADD_THRESHOLD) {
        notableAdds.push({
          franchiseName: nameOf(franchiseIdByTeamSeasonId.get(item.teamSeasonId) ?? -1),
          playerName: playerNameOf(item.playerId),
          points,
        });
      }
    }
  }

  // --- playoff picture -------------------------------------------------------
  const completedWeeksThrough = db
    .select({ week: weeks.week })
    .from(weeks)
    .where(and(eq(weeks.season, season), eq(weeks.isComplete, true)))
    .all()
    .filter((w) => w.week <= week).length;

  // Fix round 1, I3: a playoff-week recap has a decided bracket, not an open standings race — the
  // gate must also require the TARGET week itself be regular-season, not just "5+ completed weeks
  // somewhere this season" (which stayed true straight through every playoff week too).
  let playoffPicture: string[] | null = null;
  if (weekRow.weekType === "regular" && completedWeeksThrough >= 5) {
    const seasonRow = db.select({ playoffFormatJson: seasons.playoffFormatJson }).from(seasons).where(eq(seasons.season, season)).get();
    const playoffFormat = seasonRow?.playoffFormatJson as { playoffTeamCount?: unknown } | null | undefined;
    const playoffTeamCount = typeof playoffFormat?.playoffTeamCount === "number" ? playoffFormat.playoffTeamCount : null;
    if (playoffTeamCount !== null) {
      const cutlineEntries: PlayoffCutlineEntry[] = standings.map((s) => ({
        franchiseId: s.franchiseId,
        franchiseName: s.franchiseName,
        wins: s.wins,
        losses: s.losses,
        ties: s.ties,
        rank: s.rank,
      }));
      playoffPicture = computePlayoffPictureSentences(cutlineEntries, playoffTeamCount);
    }
  }

  // --- commissioner notes ------------------------------------------------
  const notesRow = db
    .select({ valueJson: appSettings.valueJson })
    .from(appSettings)
    .where(eq(appSettings.key, `recap_notes_${season}_${week}`))
    .get();
  const commissionerNotes = typeof notesRow?.valueJson === "string" && notesRow.valueJson.trim().length > 0 ? notesRow.valueJson : null;

  return {
    meta: { season, week, weekType: weekRow.weekType, scoringPeriodId: weekRow.scoringPeriodId, bracket },
    standings,
    matchups: matchupFacts,
    superlatives,
    records: { broken, approached },
    transactions: { trades, notableAdds },
    playoffPicture,
    commissionerNotes,
  };
}
