/**
 * Live event emission (Task 25) — called after every live/hourly/daily sync tier tick (see
 * `run-tier.ts`). Diffs the current normalized/derived state (matchups, belt_matches,
 * record_entries, team_week, weeks) against what's already recorded in the `events` table and
 * inserts the MVP event set with deterministic dedupe_keys. Per AGENTS.md, `events.dedupe_key` is
 * UNIQUE — every insert here uses `onConflictDoNothing`, so a re-run against unchanged state is a
 * guaranteed no-op (zero new rows) and a re-run against changed state only ever adds the NEW rows.
 * This module never updates or deletes an existing event row.
 *
 * SCOPING RULING (brief item 5's real-data scratch check): the `events` table had ZERO
 * production rows before this task. Emitting for every historical season would require a one-time
 * bounded backfill of MatchupFinished/Belt/RecordBroken events for ~10 years of already-played
 * games — but the historical timeline/records/belt pages already derive their content directly
 * from the normalized/derived tables, not from `events` (this table is a LIVE ticker feed, not a
 * system of record). RULING: emission is scoped to the CURRENT season forward, starting at
 * `EMISSION_MIN_SEASON` (2026, the season this task shipped in) — a fixed epoch, not a moving
 * "this calendar year" cutoff, so a past season never starts emitting events just because this
 * code happens to run again later. `emitEvents` is a no-op (zero candidates, zero inserts) for
 * any `season < EMISSION_MIN_SEASON`.
 *
 * Two different idempotency strategies, by event type:
 *   - MatchupFinished / BeltDefended / BeltTransferred / RecordBroken / BeatdownOfWeek: STATELESS
 *     per tick — every call recomputes the FULL current candidate set from today's DB state (a
 *     handful of rows; cheap) and inserts all of them with `onConflictDoNothing`. The dedupe key
 *     alone (matchupId; or recordKey+franchiseId+season+week; or season+week+franchiseId) is
 *     enough to make this safe: an unchanged matchup/record/week produces the SAME key every
 *     time, so re-emitting it is a guaranteed conflict, not a duplicate. This is literally the
 *     brief's own "insert-or-ignore semantics" — no separate diff pass needed.
 *   - MatchupLeadChanged: STATEFUL — the dedupe key's sequence component can only be computed by
 *     reading back the last MatchupLeadChanged event already recorded for that matchup (there is
 *     no "current sequence number" column anywhere in the normalized schema), so this one genuine
 *     diff-against-already-recorded-events step is unavoidable.
 *
 * Sentinel avoidance (see the espn-fantasy-data skill): every candidate here is gated on an
 * authoritative "this really happened" signal already produced by normalize.ts/build.ts —
 * `matchups.is_final` + non-null `winner` (never a raw 0.0 score comparison), `belt_matches` rows
 * (which only exist for matchups `replay()` treated as decided), `team_week.result`/`.margin`
 * (null until a matchup is final), and `weeks.is_complete` (every schedule entry decided). Byes
 * (`awayFranchiseId === null`) are excluded from every matchup-shaped event — there's no opponent
 * to have a lead over or a finish to announce.
 */
import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
  computeWeeklyBeatdowns,
  findRecordComparisons,
  RECORD_LABELS,
  type BeatdownTeamWeekInput,
  type ContextRecordEntryInput,
  type RecordKey,
} from "../../engines";
import type { Db } from "../db/client";
import { beltMatches, events, franchises, matchups, recordEntries, teamSeasons, teamWeek, weeks, type NewEvent } from "../db/schema";

/**
 * The season Task 25 shipped in — see the module docstring's SCOPING RULING. Deliberately a
 * fixed epoch (never "the currently active season"), so this module's behavior for any given
 * season never changes depending on when it happens to run.
 */
export const EMISSION_MIN_SEASON = 2026;

/** `events.event_type` values this module writes — also the SSE route's `event:` field values. */
export const EVENT_TYPES = {
  MATCHUP_LEAD_CHANGED: "MatchupLeadChanged",
  MATCHUP_FINISHED: "MatchupFinished",
  BELT_DEFENDED: "BeltDefended",
  BELT_TRANSFERRED: "BeltTransferred",
  RECORD_BROKEN: "RecordBroken",
  BEATDOWN_OF_WEEK: "BeatdownOfWeek",
} as const;

export type EmittedEventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export interface EmitEventsOptions {
  season: number;
  /** Injected so tests get deterministic timestamps; production omits this (real `new Date()`). */
  now?: Date;
}

export interface EmitEventsResult {
  /** Rows actually written this call (post-dedupe) — NOT the candidate count. */
  inserted: number;
}

type Leader = "home" | "away" | "tie";

interface SeasonMatchupRow {
  id: number;
  week: number;
  isFinal: boolean;
  winner: "home" | "away" | "tie" | null;
  homeScore: number;
  awayScore: number;
  homeFranchiseId: number;
  homeFranchiseName: string;
  /** Null for a bye. */
  awayFranchiseId: number | null;
  awayFranchiseName: string | null;
}

// ---------------------------------------------------------------------------
// Shared loaders
// ---------------------------------------------------------------------------

function loadSeasonMatchups(db: Db, season: number): SeasonMatchupRow[] {
  const homeTeam = alias(teamSeasons, "ee_home_team");
  const awayTeam = alias(teamSeasons, "ee_away_team");
  const homeFranchise = alias(franchises, "ee_home_franchise");
  const awayFranchise = alias(franchises, "ee_away_franchise");

  return db
    .select({
      id: matchups.id,
      week: matchups.week,
      isFinal: matchups.isFinal,
      winner: matchups.winner,
      homeScore: matchups.homeScore,
      awayScore: matchups.awayScore,
      homeFranchiseId: homeFranchise.id,
      homeFranchiseName: homeFranchise.canonicalName,
      awayFranchiseId: awayFranchise.id,
      awayFranchiseName: awayFranchise.canonicalName,
    })
    .from(matchups)
    .innerJoin(homeTeam, eq(matchups.homeTeamSeasonId, homeTeam.id))
    .innerJoin(homeFranchise, eq(homeTeam.franchiseId, homeFranchise.id))
    .leftJoin(awayTeam, eq(matchups.awayTeamSeasonId, awayTeam.id))
    .leftJoin(awayFranchise, eq(awayTeam.franchiseId, awayFranchise.id))
    .where(eq(matchups.season, season))
    .all();
}

function loadFranchiseNames(db: Db): Map<number, string> {
  const rows = db.select({ id: franchises.id, name: franchises.canonicalName }).from(franchises).all();
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ---------------------------------------------------------------------------
// MatchupLeadChanged — the one STATEFUL event type (see module docstring).
// ---------------------------------------------------------------------------

/**
 * A matchup is eligible for lead tracking once it's either final (a real, decided result — bye
 * or not, though byes are filtered separately below) or at least one side has posted a nonzero
 * score. Excludes the pregame 0-0/not-final state, which is real-but-uninteresting rather than an
 * ESPN sentinel, but "nobody has scored yet" is not a meaningful lead to announce.
 */
function isLeadEligible(m: SeasonMatchupRow): boolean {
  return m.awayFranchiseId !== null && (m.isFinal || m.homeScore !== 0 || m.awayScore !== 0);
}

function currentLeader(m: SeasonMatchupRow): Leader {
  if (m.isFinal) return m.winner ?? "tie"; // winner is non-null for every real, non-bye final match
  if (m.homeScore > m.awayScore) return "home";
  if (m.homeScore < m.awayScore) return "away";
  return "tie";
}

interface PriorLeadState {
  leader: Leader;
  sequence: number;
}

function isLeader(value: unknown): value is Leader {
  return value === "home" || value === "away" || value === "tie";
}

/** The latest MatchupLeadChanged event already recorded per matchup, read back from `events` —
 * this IS the "diff vs already recorded events" step the brief describes for this event type. */
function loadPriorLeadStateByMatchup(db: Db, season: number): Map<number, PriorLeadState> {
  const rows = db
    .select({ matchupId: events.matchupId, payloadJson: events.payloadJson })
    .from(events)
    .where(and(eq(events.eventType, EVENT_TYPES.MATCHUP_LEAD_CHANGED), eq(events.season, season)))
    .orderBy(desc(events.id))
    .all();

  const out = new Map<number, PriorLeadState>();
  for (const r of rows) {
    if (r.matchupId === null || out.has(r.matchupId)) continue; // desc order -> first seen per id is newest
    const payload = r.payloadJson as { leader?: unknown; sequence?: unknown };
    if (!isLeader(payload.leader)) continue;
    const sequence = typeof payload.sequence === "number" ? payload.sequence : 0;
    out.set(r.matchupId, { leader: payload.leader, sequence });
  }
  return out;
}

function computeLeadChangeCandidates(db: Db, season: number, matchupRows: SeasonMatchupRow[], now: Date): NewEvent[] {
  const eligible = matchupRows.filter(isLeadEligible);
  if (eligible.length === 0) return [];

  const priorByMatchup = loadPriorLeadStateByMatchup(db, season);

  const out: NewEvent[] = [];
  for (const m of eligible) {
    const leader = currentLeader(m);
    const prior = priorByMatchup.get(m.id);
    if (prior && prior.leader === leader) continue; // no change since the last recorded event

    const sequence = prior ? prior.sequence + 1 : 0;
    const leaderFranchiseId = leader === "home" ? m.homeFranchiseId : leader === "away" ? m.awayFranchiseId : null;

    out.push({
      eventType: EVENT_TYPES.MATCHUP_LEAD_CHANGED,
      season,
      week: m.week,
      occurredAt: now,
      detectedAt: now,
      franchiseId: leaderFranchiseId,
      matchupId: m.id,
      playerId: null,
      dedupeKey: `matchup_lead_changed:${m.id}:${sequence}`,
      payloadJson: {
        matchupId: m.id,
        season,
        week: m.week,
        sequence,
        leader,
        homeFranchiseId: m.homeFranchiseId,
        homeFranchiseName: m.homeFranchiseName,
        homeScore: m.homeScore,
        awayFranchiseId: m.awayFranchiseId,
        awayFranchiseName: m.awayFranchiseName,
        awayScore: m.awayScore,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// MatchupFinished — STATELESS (dedupe key alone provides idempotency).
// ---------------------------------------------------------------------------

function computeMatchupFinishedCandidates(season: number, matchupRows: SeasonMatchupRow[], now: Date): NewEvent[] {
  const out: NewEvent[] = [];
  for (const m of matchupRows) {
    if (!m.isFinal || m.awayFranchiseId === null || m.winner === null) continue; // exclude byes/unplayed
    const winnerFranchiseId = m.winner === "home" ? m.homeFranchiseId : m.winner === "away" ? m.awayFranchiseId : null;

    out.push({
      eventType: EVENT_TYPES.MATCHUP_FINISHED,
      season,
      week: m.week,
      occurredAt: now,
      detectedAt: now,
      franchiseId: winnerFranchiseId,
      matchupId: m.id,
      playerId: null,
      dedupeKey: `matchup_finished:${m.id}`,
      payloadJson: {
        matchupId: m.id,
        season,
        week: m.week,
        homeFranchiseId: m.homeFranchiseId,
        homeFranchiseName: m.homeFranchiseName,
        homeScore: m.homeScore,
        awayFranchiseId: m.awayFranchiseId,
        awayFranchiseName: m.awayFranchiseName,
        awayScore: m.awayScore,
        winner: m.winner,
        winnerFranchiseId,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// BeltDefended / BeltTransferred — STATELESS. `belt_matches.matchup_id` is itself UNIQUE, so one
// row per matchup already; only ever produced for a matchup `replay()` treated as decided.
// ---------------------------------------------------------------------------

function computeBeltCandidates(db: Db, season: number, franchiseNames: Map<number, string>, now: Date): NewEvent[] {
  const rows = db.select().from(beltMatches).where(eq(beltMatches.season, season)).all();

  const out: NewEvent[] = [];
  for (const bm of rows) {
    const isDefense = bm.result === "defense";
    out.push({
      eventType: isDefense ? EVENT_TYPES.BELT_DEFENDED : EVENT_TYPES.BELT_TRANSFERRED,
      season,
      week: bm.week,
      occurredAt: now,
      detectedAt: now,
      franchiseId: isDefense ? bm.holderFranchiseId : bm.challengerFranchiseId,
      matchupId: bm.matchupId,
      playerId: null,
      dedupeKey: `${isDefense ? "belt_defended" : "belt_transferred"}:${bm.matchupId}`,
      payloadJson: {
        matchupId: bm.matchupId,
        season,
        week: bm.week,
        result: bm.result,
        holderFranchiseId: bm.holderFranchiseId,
        holderFranchiseName: franchiseNames.get(bm.holderFranchiseId) ?? null,
        holderScore: bm.holderScore,
        challengerFranchiseId: bm.challengerFranchiseId,
        challengerFranchiseName: franchiseNames.get(bm.challengerFranchiseId) ?? null,
        challengerScore: bm.challengerScore,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// RecordBroken — STATELESS. Reuses the context engine's chronology-safe comparison
// (`findRecordComparisons`, src/engines/context.ts) so this can never disagree with the
// record_broken context note about which historical record a result actually broke.
// ---------------------------------------------------------------------------

function computeRecordBrokenCandidates(db: Db, season: number, franchiseNames: Map<number, string>, now: Date): NewEvent[] {
  // The comparison needs FULL history (a 2026 result may break a record set in 2019), not just
  // this season's rows — record_entries is small (top-10-per-key) regardless, so this is cheap.
  const allEntries = db.select().from(recordEntries).all();
  const inputs: ContextRecordEntryInput[] = allEntries.map((e) => ({
    recordKey: e.recordKey as RecordKey,
    rank: e.rank,
    franchiseId: e.franchiseId,
    season: e.season,
    week: e.week,
    value: e.value,
  }));

  const comparisons = findRecordComparisons(inputs).filter((c) => c.entry.season === season);
  if (comparisons.length === 0) return [];

  // Best-effort matchup id for a richer payload (the ticker line can link straight to the game).
  const teamWeekRows = db
    .select({ franchiseId: teamWeek.franchiseId, week: teamWeek.week, matchupId: teamWeek.matchupId })
    .from(teamWeek)
    .where(eq(teamWeek.season, season))
    .all();
  const matchupIdByKey = new Map(teamWeekRows.map((r) => [`${r.franchiseId}:${r.week}`, r.matchupId]));

  const out: NewEvent[] = [];
  for (const c of comparisons) {
    const kind: "sets" | "ties" | "breaks" = !c.comparisonEntry ? "sets" : c.entry.value === c.comparisonEntry.value ? "ties" : "breaks";
    out.push({
      eventType: EVENT_TYPES.RECORD_BROKEN,
      season,
      week: c.entry.week,
      occurredAt: now,
      detectedAt: now,
      franchiseId: c.entry.franchiseId,
      matchupId: matchupIdByKey.get(`${c.entry.franchiseId}:${c.entry.week}`) ?? null,
      playerId: null,
      dedupeKey: `record_broken:${c.recordKey}:${c.entry.franchiseId}:${c.entry.season}:${c.entry.week}`,
      payloadJson: {
        recordKey: c.recordKey,
        recordLabel: RECORD_LABELS[c.recordKey],
        franchiseId: c.entry.franchiseId,
        franchiseName: franchiseNames.get(c.entry.franchiseId) ?? null,
        season: c.entry.season,
        week: c.entry.week,
        value: c.entry.value,
        kind,
        previousValue: c.comparisonEntry?.value ?? null,
        previousSeason: c.comparisonEntry?.season ?? null,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// BeatdownOfWeek — STATELESS, fires once a week is fully complete (`weeks.is_complete`, the same
// "every schedule entry decided" signal normalize.ts already computes). Reuses
// `computeWeeklyBeatdowns` (src/engines/records.ts) — the SAME derivation stage 4's
// season/career `beatdowns` counts and the context engine's `beatdown_of_week` rule use, so all
// three can never disagree about who won a given week's award.
// ---------------------------------------------------------------------------

function computeBeatdownCandidates(db: Db, season: number, franchiseNames: Map<number, string>, now: Date): NewEvent[] {
  const completeWeeks = new Set(
    db
      .select({ week: weeks.week })
      .from(weeks)
      .where(and(eq(weeks.season, season), eq(weeks.isComplete, true)))
      .all()
      .map((w) => w.week),
  );
  if (completeWeeks.size === 0) return [];

  const teamWeekRows = db
    .select({ franchiseId: teamWeek.franchiseId, week: teamWeek.week, result: teamWeek.result, margin: teamWeek.margin })
    .from(teamWeek)
    .where(eq(teamWeek.season, season))
    .all();
  const beatdownInputs: BeatdownTeamWeekInput[] = teamWeekRows.map((r) => ({
    franchiseId: r.franchiseId,
    season,
    week: r.week,
    result: r.result,
    margin: r.margin,
  }));
  const awards = computeWeeklyBeatdowns(beatdownInputs).filter((a) => completeWeeks.has(a.week));
  if (awards.length === 0) return [];

  // Same all-time-rank escalation the context engine's beatdown_of_week rule uses (top-3
  // `worst_beatdown` entries), so the ticker's wording can match the site's own framing.
  const topRankByKey = new Map<string, number>();
  const worstBeatdownEntries = db
    .select({ franchiseId: recordEntries.franchiseId, week: recordEntries.week, rank: recordEntries.rank })
    .from(recordEntries)
    .where(and(eq(recordEntries.recordKey, "worst_beatdown"), eq(recordEntries.season, season)))
    .all();
  for (const e of worstBeatdownEntries) {
    if (e.week === null || e.rank > 3) continue;
    topRankByKey.set(`${e.franchiseId}:${e.week}`, e.rank);
  }

  const out: NewEvent[] = [];
  for (const award of awards) {
    const allTimeRank = topRankByKey.get(`${award.franchiseId}:${award.week}`) ?? null;
    out.push({
      eventType: EVENT_TYPES.BEATDOWN_OF_WEEK,
      season,
      week: award.week,
      occurredAt: now,
      detectedAt: now,
      franchiseId: award.franchiseId,
      matchupId: null,
      playerId: null,
      dedupeKey: `beatdown_of_week:${season}:${award.week}:${award.franchiseId}`,
      payloadJson: {
        season,
        week: award.week,
        franchiseId: award.franchiseId,
        franchiseName: franchiseNames.get(award.franchiseId) ?? null,
        margin: award.margin,
        allTimeRank,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Diffs the current season's normalized/derived state against `events` and inserts the MVP event
 * set. Safe to call after ANY sync tier tick (live/hourly/daily), including one where nothing
 * actually changed — see the module docstring for why each event type's idempotency holds either
 * way. Returns the number of rows actually written (after dedupe), for `sync_runs.events_emitted`.
 */
export function emitEvents(db: Db, opts: EmitEventsOptions): EmitEventsResult {
  const { season } = opts;
  const now = opts.now ?? new Date();

  if (season < EMISSION_MIN_SEASON) return { inserted: 0 }; // SCOPING RULING — see module docstring

  const matchupRows = loadSeasonMatchups(db, season);
  const franchiseNames = loadFranchiseNames(db);

  const candidates: NewEvent[] = [
    ...computeLeadChangeCandidates(db, season, matchupRows, now),
    ...computeMatchupFinishedCandidates(season, matchupRows, now),
    ...computeBeltCandidates(db, season, franchiseNames, now),
    ...computeRecordBrokenCandidates(db, season, franchiseNames, now),
    ...computeBeatdownCandidates(db, season, franchiseNames, now),
  ];

  if (candidates.length === 0) return { inserted: 0 };

  const result = db.insert(events).values(candidates).onConflictDoNothing({ target: events.dedupeKey }).run();
  return { inserted: result.changes };
}
