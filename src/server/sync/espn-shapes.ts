/**
 * Loosely-typed ESPN Fantasy v3 payload shapes shared by `validate.ts` and
 * `normalize.ts`. These are transcribed from the task brief's best-effort,
 * community-documented field list, NOT from ESPN's own schema (there isn't
 * a public one) — every field is optional here on purpose. Real payloads
 * (once the backfill in Task 4 has run against a live league) may omit,
 * rename, or restructure fields; callers MUST optional-chain through these
 * and treat anything missing as "unknown, warn and move on" rather than a
 * crash. See AGENTS.md and the Task 5 brief's "ESPN payload shapes" section.
 */

/** `snapshots.view` key for a season-scope fetch (sorted, comma-joined — see `sync/snapshots.ts`). */
export const SEASON_SCOPE_VIEW_KEY = "mDraftDetail,mMatchup,mSettings,mStandings,mTeam,mTransactions2";

/** `snapshots.view` key for a weekly (scoringPeriodId-scoped) fetch. */
export const WEEK_SCOPE_VIEW_KEY = "mBoxscore,mMatchupScore,mRoster";

/**
 * `snapshots.view` key for a per-period transactions-only fetch. Confirmed
 * by live probe (Task 7): `mTransactions2` returns no `transactions` data
 * at all without a `scoringPeriodId` param, and a per-period list with one
 * — this is its own snapshot lineage, separate from `WEEK_SCOPE_VIEW_KEY`.
 */
export const TRANSACTIONS_VIEW_KEY = "mTransactions2";

/**
 * ESPN's `leagueHistory` endpoint (the only one that still has data for
 * pre-modern seasons, confirmed against real archived 2015-2017 snapshots)
 * wraps the league object in an ARRAY instead of returning it directly —
 * `[ { seasonId: 2015, settings: {...}, ... } ]`, length 1 in every case
 * observed so far, but this defensively handles a longer array too. A plain
 * (non-array) payload passes through unchanged, so this is safe to call
 * unconditionally on every parsed season-scope payload regardless of era.
 *
 * Shared by every season-scope payload consumer (`validate.ts`,
 * `normalize.ts` via `validate.ts`'s parsed result, and
 * `franchise-map.ts`'s `suggestFranchises`) so a fix here benefits all
 * three at once — this was previously missing, which silently skipped
 * 2015-2017 entirely (a bare `typeof x === "object"` check passes for an
 * array, so it looked "present" while every field read underneath failed).
 */
export function unwrapLeagueHistoryPayload(json: unknown, season?: number): unknown {
  if (!Array.isArray(json)) return json;
  if (json.length === 0) return undefined;
  if (season !== undefined) {
    const match = json.find(
      (entry) => entry !== null && typeof entry === "object" && (entry as { seasonId?: unknown }).seasonId === season,
    );
    if (match !== undefined) return match;
  }
  return json[0];
}

// ---------------------------------------------------------------------------
// Season scope (`mDraftDetail,mMatchup,mSettings,mStandings,mTeam,mTransactions2`)
// ---------------------------------------------------------------------------

export interface EspnTeamRecordOverall {
  wins?: unknown;
  losses?: unknown;
  ties?: unknown;
  pointsFor?: unknown;
  pointsAgainst?: unknown;
}

export interface EspnTeam {
  id?: unknown;
  abbrev?: unknown;
  name?: unknown;
  location?: unknown;
  nickname?: unknown;
  logo?: unknown;
  divisionId?: unknown;
  /** SWID strings (or, defensively, `{id: swid}` objects on older payloads). */
  owners?: unknown;
  record?: { overall?: EspnTeamRecordOverall };
  playoffSeed?: unknown;
  rankCalculatedFinal?: unknown;
}

export interface EspnMember {
  id?: unknown;
  displayName?: unknown;
  firstName?: unknown;
  lastName?: unknown;
}

export interface EspnScheduleSide {
  teamId?: unknown;
  totalPoints?: unknown;
  totalPointsLive?: unknown;
}

export interface EspnScheduleEntry {
  id?: unknown;
  matchupPeriodId?: unknown;
  home?: EspnScheduleSide;
  /** Absent entirely for byes. */
  away?: EspnScheduleSide;
  winner?: unknown;
  playoffTierType?: unknown;
}

export interface EspnDraftPick {
  playerId?: unknown;
  teamId?: unknown;
  roundId?: unknown;
  roundPickNumber?: unknown;
  overallPickNumber?: unknown;
  keeper?: unknown;
  bidAmount?: unknown;
}

/**
 * Real `type` values confirmed by live probe against `mTransactions2`
 * (Task 7): `"ADD"`, `"DROP"`, `"TRADE"` (a single item carries BOTH real
 * `fromTeamId`/`toTeamId` — there's no separate ADD+DROP pair for a trade
 * leg), `"LINEUP"`, `"DRAFT"`. `fromTeamId`/`toTeamId` are `0` for the
 * free-agent pool side of an ADD/DROP, never for a TRADE item.
 */
export interface EspnTransactionItem {
  playerId?: unknown;
  type?: unknown;
  fromTeamId?: unknown;
  toTeamId?: unknown;
}

/**
 * Real `type` values confirmed by live probe (Task 7): `"WAIVER"`,
 * `"FREEAGENT"`, `"ROSTER"`, `"FUTURE_ROSTER"`, `"DRAFT"`,
 * `"TRADE_PROPOSAL"` — `"TRADE_ACCEPT"`/`"TRADE_UPHOLD"` per the brief's
 * controller-verified list (not directly observed in the probed periods,
 * which had no completed trades). Real `status` values confirmed:
 * `"EXECUTED"`, `"PENDING"`, `"CANCELED"`, `"FAILED_INVALIDPLAYERSOURCE"`
 * (and presumably other `FAILED_*` variants) — `status === "EXECUTED"` is
 * the one reliable "this actually happened" signal across every `type`.
 * `id` is a UUID **string** in every real transaction, not a number.
 */
export interface EspnTransaction {
  id?: unknown;
  type?: unknown;
  status?: unknown;
  bidAmount?: unknown;
  proposedDate?: unknown;
  /** Confirmed present (as `processDate`) on a real executed WAIVER transaction. */
  processDate?: unknown;
  /** Never observed in real data — kept as a defensive fallback per the brief's field list. */
  executionDate?: unknown;
  items?: EspnTransactionItem[];
}

/** Top-level shape of a per-period `view=mTransactions2&scoringPeriodId=N` response. */
export interface EspnTransactionsPayload {
  transactions?: EspnTransaction[];
}

export interface EspnSeasonSettings {
  name?: unknown;
  /** Community-documented league-size field; validated against `teams.length` when present. */
  size?: unknown;
  rosterSettings?: { lineupSlotCounts?: Record<string, unknown> };
  scheduleSettings?: { matchupPeriodCount?: unknown };
  scoringSettings?: unknown;
  [key: string]: unknown;
}

export interface EspnSeasonStatus {
  finalScoringPeriod?: unknown;
  currentMatchupPeriod?: unknown;
  latestScoringPeriod?: unknown;
}

export interface EspnSeasonScopePayload {
  settings?: EspnSeasonSettings;
  status?: EspnSeasonStatus;
  teams?: EspnTeam[];
  members?: EspnMember[];
  schedule?: EspnScheduleEntry[];
  draftDetail?: { picks?: EspnDraftPick[] };
  transactions?: EspnTransaction[];
}

// ---------------------------------------------------------------------------
// Weekly scope (`mBoxscore,mMatchupScore,mRoster`), scoped by scoringPeriodId
// ---------------------------------------------------------------------------

export interface EspnPlayerStat {
  scoringPeriodId?: unknown;
  statSourceId?: unknown;
  appliedTotal?: unknown;
}

export interface EspnPlayer {
  id?: unknown;
  fullName?: unknown;
  defaultPositionId?: unknown;
  eligibleSlots?: unknown;
  proTeamId?: unknown;
  stats?: EspnPlayerStat[];
  /**
   * Task 20 ground truth: real values observed across the full archive (24,651 entries, all
   * seasons) are `ACTIVE` (18008), `QUESTIONABLE` (4010), `INJURY_RESERVE` (337), `OUT` (84),
   * `DOUBTFUL` (17), `SUSPENSION` (14), or simply absent (2181). FIX ROUND 1 CORRECTION: the
   * absent cases are OVERWHELMINGLY but not exclusively `defaultPositionId === 16` (D/ST) —
   * 2166/2181 (99.3%) are D/ST; the original report claimed 100% ("confirmed by direct query"),
   * which a reviewer's independent full-archive scan disproved — 15 exceptions exist, all 2018:
   * 13 `Kareem Hunt` (RB) entries and 2 `Sam Ficken` (K) entries. No behavioral impact — this
   * module never gates on position; an absent status is always treated as `null` regardless of
   * who carries it — but the docstring must state the true distribution, not an unverified round
   * number. This is the ONLY reliable injury-status field — see
   * `EspnWeekScopeRosterEntry.injuryStatus` below for a same-named field that is NOT reliable.
   */
  injuryStatus?: unknown;
}

export interface EspnPlayerPoolEntry {
  id?: unknown;
  appliedStatTotal?: unknown;
  player?: EspnPlayer;
}

export interface EspnRosterEntry {
  lineupSlotId?: unknown;
  playerPoolEntry?: EspnPlayerPoolEntry;
}

export interface EspnWeeklyScheduleSide {
  teamId?: unknown;
  rosterForCurrentScoringPeriod?: { entries?: EspnRosterEntry[] };
}

export interface EspnWeeklyScheduleEntry {
  id?: unknown;
  matchupPeriodId?: unknown;
  home?: EspnWeeklyScheduleSide;
  away?: EspnWeeklyScheduleSide;
  winner?: unknown;
  /**
   * Confirmed against real archived data: this field does NOT exist on the
   * season-scope `schedule[]` in any real season — only here, on the WEEKLY
   * (`mBoxscore,mMatchupScore,mRoster`) payload's schedule, which carries
   * the full season's schedule (not just the fetched week) with tier data
   * attached to every entry. See `normalize.ts`'s `buildTierByEntryId`.
   */
  playoffTierType?: unknown;
}

/**
 * Task 20 ground truth (verified against real archived `data/league.db`, not assumed): the weekly
 * (`mBoxscore,mMatchupScore,mRoster`) payload ALSO carries a top-level `teams[]` array — separate
 * from, and structurally different than, `schedule[].home/away.rosterForCurrentScoringPeriod`
 * (`EspnWeeklyScheduleSide` above, which `normalize.ts` builds `roster_slots` from). `teams[].
 * roster.entries[]` is where real per-player injury data actually lives; `roster_slots` has no such
 * column and `normalize.ts` never reads this array — see `src/server/sync/lineup-holes.ts`, the
 * first (and so far only) consumer of it.
 *
 * SENTINEL TRAP: `EspnWeekScopeRosterEntry.injuryStatus` (sibling of `lineupSlotId`) is a
 * DIFFERENT, same-named field than `playerPoolEntry.player.injuryStatus` (`EspnPlayer.
 * injuryStatus` above) and the two do NOT agree — the entry-level one was `"NORMAL"` on every
 * single entry observed in a full-league week sample (201/201), i.e. it does not vary and is not a
 * real signal, while the player-level one carries the genuine, real-world designation. Typed here
 * (rather than omitted) specifically so a future reader isn't tempted to reach for the wrong one.
 */
export interface EspnWeekScopeRosterEntry {
  lineupSlotId?: unknown;
  /** NOT the real injury signal — see this interface's docstring. */
  injuryStatus?: unknown;
  playerId?: unknown;
  playerPoolEntry?: EspnPlayerPoolEntry;
}

export interface EspnWeekScopeTeam {
  id?: unknown;
  roster?: { entries?: EspnWeekScopeRosterEntry[] };
}

export interface EspnWeekScopePayload {
  schedule?: EspnWeeklyScheduleEntry[];
  teams?: EspnWeekScopeTeam[];
}
