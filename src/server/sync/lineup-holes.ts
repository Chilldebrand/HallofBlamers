/**
 * Lineup-hole detection & event emission (Task 20) — flags empty or injury/suspension-disqualified
 * STARTING roster slots for the CURRENT week, before kickoff, so a future admin panel/ticker can
 * surface "who's not set." Called from `run-tier.ts`'s hourly/live ticks, alongside
 * `emit-events.ts`'s matchup-derived events, into the SAME `events` table via the SAME
 * insert-or-ignore-on-`dedupe_key` idempotency pattern that module establishes (see its docstring
 * for the general shape reused here). HARD RULE (task brief): read-only monitoring — this module
 * never writes anything to ESPN; lineups are fixed by managers themselves on ESPN's own site.
 *
 * GROUND TRUTH (Task 20 brief step 1 — verified against a read-only scratch copy of the real
 * archived `data/league.db`, never assumed from community docs):
 *
 *   - EMPTY starting slots are represented by ABSENCE, not a placeholder row: `roster_slots` (and
 *     the raw `schedule[].home/away.rosterForCurrentScoringPeriod.entries` it's built from) only
 *     ever contains a row for a player who genuinely IS on the roster — there is no sentinel
 *     "empty slot" player id anywhere in real data. The only way to detect an empty starting slot
 *     is to compare the ACTUAL count of starter rows per `lineup_slot` label against the season's
 *     CONFIGURED starting count (`seasons.settings_json.rosterSettings.lineupSlotCounts`) — reused
 *     directly via `stats/build.ts`'s exported `resolveStartingSlotCounts` rather than re-derived,
 *     so optimal-lineup efficiency and lineup-hole detection can never disagree about what a "full"
 *     lineup looks like. FIX ROUND 1 CORRECTION: the original report claimed "a real empty
 *     starting slot has never occurred in this league's history," stated as directly-verified
 *     fact — a reviewer's independent cross-reference of `roster_slots` against each season's
 *     configured `lineupSlotCounts` disproved this: **9 genuine historical empty-starter-slot
 *     instances exist**, across 6 distinct team/weeks — 2018 wk1 D/ST (espnTeamId 2, "Two Time
 *     Timmy": both "Eagles D/ST" and "Lions D/ST" rostered but BENCHED at `lineupSlotId 20`, zero
 *     entries at `lineupSlotId 16`), 2019 wk9 D/ST (espnTeamId 1), 2019 wk15+wk16 TE (espnTeamId
 *     6), 2021 wk15 WR *and* K simultaneously (espnTeamId 1), 2023 wk10 D/ST (espnTeamId 12), 2024
 *     wk11 TE + wk14 K (espnTeamId 6, same franchise both weeks). The detection mechanism itself
 *     was never in question — every one of these 9 would have been correctly flagged — but the
 *     "purely hypothetical, only fixture-tested" framing was false. The 2018 wk1 D/ST instance is
 *     now reconstructed verbatim (real season/week/slot/roster shape) as a regression fixture —
 *     see `src/engines/__fixtures__/lineupHoles.ts`'s `REAL_2018_WK1_EMPTY_DST_*` exports and the
 *     corresponding test in `src/engines/__tests__/lineupHoles.test.ts`.
 *
 *   - injuryStatus is NOT in `roster_slots` (the schema has no such column, and `normalize.ts`
 *     never reads it) and is NOT on `schedule[].home/away.rosterForCurrentScoringPeriod.entries`
 *     (the source `roster_slots` is built from) at all. It DOES exist, but on a completely separate
 *     part of the SAME weekly (`mBoxscore,mMatchupScore,mRoster`) snapshot: the top-level `teams[]`
 *     array (`EspnWeekScopeTeam` / `EspnWeekScopeRosterEntry` in `espn-shapes.ts`), which mirrors
 *     each team's CURRENT roster/lineup independent of the matchup-scoped `schedule[]` side. This
 *     module reads that array directly from whatever the hourly/live fetch phase already archived
 *     (NEVER issues a new ESPN request of its own) and joins it back to `roster_slots` by
 *     (espnTeamId, playerId).
 *
 *   - SENTINEL TRAP (the actual reason injuryStatus needed its own lookup rather than a `roster_
 *     slots` column added in normalize.ts): a roster entry carries TWO different fields both
 *     plausibly named "injury status," and they do NOT agree. `entry.injuryStatus` (sibling of
 *     `lineupSlotId`) was `"NORMAL"` on EVERY entry ever observed (201/201 in one full-league week
 *     sampled) — it does not vary and is not a real signal. `entry.playerPoolEntry.player.
 *     injuryStatus` is the genuine designation and takes the values actually observed across the
 *     FULL archive: `ACTIVE`, `QUESTIONABLE`, `OUT`, `DOUBTFUL`, `SUSPENSION`, `INJURY_RESERVE`, or
 *     simply ABSENT. FIX ROUND 1 CORRECTION: the absent cases are OVERWHELMINGLY (2166/2181, 99.3%)
 *     `defaultPositionId === 16` (team defenses, which carry no injury designation at all) but NOT
 *     100% — the original "100%, confirmed by direct query" claim was false; a reviewer's
 *     independent full-archive scan found 15 exceptions, all 2018: 13 `Kareem Hunt` (RB) entries
 *     and 2 `Sam Ficken` (K) entries (see `espn-shapes.ts`'s `EspnPlayer.injuryStatus` docstring for
 *     the exact counts). No behavioral impact — this module treats every absent status as `null`
 *     regardless of position, never gates on `defaultPositionId` — but the claim itself was wrong
 *     and is corrected here. This module reads ONLY the player-level field — see
 *     `EspnWeekScopeRosterEntry`'s docstring in `espn-shapes.ts` for the full finding.
 *
 *   - HISTORICAL DATA CAVEAT: `player.injuryStatus` reflects the player's status AS OF THE FETCH,
 *     not necessarily the historical week being viewed — real 2018 week-1/2 archived snapshots show
 *     roughly ten different players simultaneously "INJURY_RESERVE" while STARTED in ordinary
 *     (non-IR) slots across many different teams, which is not a plausible real state for that many
 *     managers at once. The far more plausible explanation is that ESPN's player endpoint answers
 *     with each player's status as of whenever this league's backfill actually ran, regardless of
 *     which historical scoring period was requested — no other season shows this pattern. This is
 *     exactly why this feature deliberately never runs against historical weeks: production only
 *     ever calls `emitLineupHoleEvents` for the CURRENT season's CURRENT (non-final) scoring
 *     period, where "as of fetch" and "the week being evaluated" are the same thing by
 *     construction (see `run-tier.ts`'s call site) — so this caveat cannot actually bite in
 *     production, only a hypothetical historical backfill of this same logic, which nothing in
 *     this codebase does or should do.
 *
 *   - BYE-week detection is NOT possible from stored data: no snapshot (weekly or season-scope) in
 *     the entire real archive contains the NFL pro-team schedule or bye-week list anywhere — a raw
 *     case-insensitive "bye" substring search across every archived payload for this league found
 *     zero matches. Excluded from this task's scope entirely, per the brief's "exclude
 *     half-guessable signals rather than fabricating" instruction.
 *
 * DISQUALIFYING injuryStatus values and the QUESTIONABLE exclusion are documented on
 * `src/engines/lineupHoles.ts` (the pure decision), not repeated here.
 *
 * SCOPING RULINGS (mirrors `emit-events.ts`):
 *   - No-op for `season < EMISSION_MIN_SEASON` (2026) — same fixed-epoch reasoning as that module;
 *     this is a new event family with no historical backfill need.
 *   - Only runs for franchises whose CURRENT week's matchup is NOT final yet ("already-final weeks"
 *     sentinel rule from the brief) — a matchup can go final mid-week (Thursday/Sunday games decide
 *     before Monday's), and once a franchise's own game is over there is no more "before kickoff"
 *     to warn about. IMPLICIT CONSEQUENCE (fix round 1, reviewer Minor finding #3): a franchise
 *     whose matchup goes final between ticks simply stops being a candidate, so any of its
 *     still-open holes get a `LineupHoleResolved` row next tick even though nothing was actually
 *     fixed — see the `TODO` at the resolve-pass call site below for the deferred `resolvedReason`
 *     follow-up this implies for the eventual UI consumer.
 *   - The caller (`run-tier.ts`) is responsible for the "season underway" gate (via
 *     `isSeasonUnderway`/`getCurrentScoringPeriod`) — this module only knows about a specific
 *     `(season, week)`, not wall-clock/season state.
 *
 * DEDUPE KEY DESIGN (judgment call, extending emit-events.ts's pattern): the brief specifies
 * "franchise/season/week/slot/reason." A "disqualified" hole additionally embeds `playerId` (a
 * slot label alone can hold 2 starters, e.g. RB — two DIFFERENT disqualified RB starters must not
 * collide onto one key and silently drop one). An "empty" hole embeds its 1-based `emptyIndex`
 * instead (no player to anchor to — see `src/engines/lineupHoles.ts`'s docstring). The actual
 * observed `injuryStatus` value is deliberately EXCLUDED from the key (kept in the payload only) —
 * a player wobbling between two disqualifying values (e.g. OUT -> DOUBTFUL) within the same week is
 * treated as the SAME ongoing hole, not a resolve+redetect pair, which would otherwise be noisy and
 * misleading on a ticker.
 *
 * KNOWN LIMITATION (documented, not engineered around, given this is read-only monitoring and the
 * admin panel ships later): a hole that gets resolved and then genuinely RE-OCCURS later in the
 * SAME week (e.g. a practice-report flip-flop) reuses the identical dedupe key as the original
 * detection, which already exists in `events` — so the re-occurrence is silently absorbed rather
 * than re-flagged. `MatchupLeadChanged` (emit-events.ts) solves the analogous problem with a
 * stateful sequence number; that complexity was deliberately not replicated here, since the brief's
 * own dedupe-key spec (franchise/season/week/slot/reason) doesn't call for it and this is a v1 of a
 * new, backend-only feature.
 */
import { and, eq } from "drizzle-orm";
import { detectLineupHoles, type LineupHole, type LineupHoleStarterInput } from "../../engines";
import type { Db } from "../db/client";
import { events, franchises, matchups, players, rosterSlots, seasons, teamSeasons, type NewEvent } from "../db/schema";
import type { EspnWeekScopePayload } from "./espn-shapes";
import { WEEK_SCOPE_VIEW_KEY } from "./espn-shapes";
import { EMISSION_MIN_SEASON } from "./emit-events";
import { asFiniteNumber, asNonEmptyString } from "./parse-utils";
import { getLatestSnapshot } from "./snapshots";
import { resolveStartingSlotCounts } from "../stats/build";

export const LINEUP_EVENT_TYPES = {
  LINEUP_HOLE_DETECTED: "LineupHoleDetected",
  LINEUP_HOLE_RESOLVED: "LineupHoleResolved",
} as const;

export type LineupEventType = (typeof LINEUP_EVENT_TYPES)[keyof typeof LINEUP_EVENT_TYPES];

const DETECTED_PREFIX = "lineup_hole_detected:";
const RESOLVED_PREFIX = "lineup_hole_resolved:";

export interface EmitLineupHoleEventsOptions {
  season: number;
  week: number;
  /** Injected so tests get deterministic timestamps; production omits this (real `new Date()`). */
  now?: Date;
}

export interface EmitLineupHoleEventsResult {
  /** Rows actually written this call (post-dedupe, detected + resolved combined) — NOT the
   * candidate count. */
  inserted: number;
}

// ---------------------------------------------------------------------------
// injuryStatus lookup — reads the archived weekly snapshot's `teams[]` array directly (see module
// docstring). Never issues a new ESPN request.
// ---------------------------------------------------------------------------

/** `${espnTeamId}:${playerId}` -> the real player-level injuryStatus string. Entries with no
 * resolvable status (missing key, non-string, or the whole snapshot missing/unparseable) are simply
 * absent from the map — callers treat a missing entry as `null`, never fabricated. */
function loadInjuryStatusByTeamPlayer(db: Db, season: number, week: number): Map<string, string> {
  const out = new Map<string, string>();

  const snapshot = getLatestSnapshot(db, { season, view: WEEK_SCOPE_VIEW_KEY, scoringPeriod: week });
  if (!snapshot) return out;

  let parsed: EspnWeekScopePayload;
  try {
    parsed = JSON.parse(snapshot.payload) as EspnWeekScopePayload;
  } catch {
    return out;
  }

  const teams = Array.isArray(parsed.teams) ? parsed.teams : [];
  for (const team of teams) {
    const espnTeamId = asFiniteNumber(team.id);
    if (espnTeamId === undefined) continue;

    const entries = Array.isArray(team.roster?.entries) ? team.roster!.entries! : [];
    for (const entry of entries) {
      const playerId = asFiniteNumber(entry.playerPoolEntry?.player?.id) ?? asFiniteNumber(entry.playerPoolEntry?.id);
      if (playerId === undefined) continue;

      // Player-level field ONLY — the entry-level `injuryStatus` sibling of `lineupSlotId` is the
      // documented sentinel trap (module docstring), never read here.
      const injuryStatus = asNonEmptyString(entry.playerPoolEntry?.player?.injuryStatus);
      if (injuryStatus === undefined) continue; // D/ST or genuinely absent — never fabricated

      out.set(`${espnTeamId}:${playerId}`, injuryStatus);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Per-franchise starter rows — roster_slots (already normalized) + the injury lookup above.
// ---------------------------------------------------------------------------

interface FranchiseRosterContext {
  franchiseId: number;
  franchiseName: string;
  matchupId: number | null;
  starters: LineupHoleStarterInput[];
}

/** Every franchise with a NOT-YET-FINAL matchup this (season, week) — "already-final weeks"
 * sentinel rule (module docstring) — each seeded with an empty starters list even before the
 * roster_slots join below, so a franchise with zero archived starter rows still gets its full
 * configured deficit computed rather than silently skipped. */
function loadFranchiseRosterContexts(db: Db, season: number, week: number): FranchiseRosterContext[] {
  const matchupRows = db
    .select({ id: matchups.id, homeTeamSeasonId: matchups.homeTeamSeasonId, awayTeamSeasonId: matchups.awayTeamSeasonId, isFinal: matchups.isFinal })
    .from(matchups)
    .where(and(eq(matchups.season, season), eq(matchups.week, week)))
    .all();

  const matchupIdByTeamSeasonId = new Map<number, number>();
  for (const m of matchupRows) {
    if (m.isFinal) continue;
    matchupIdByTeamSeasonId.set(m.homeTeamSeasonId, m.id);
    if (m.awayTeamSeasonId !== null) matchupIdByTeamSeasonId.set(m.awayTeamSeasonId, m.id);
  }
  if (matchupIdByTeamSeasonId.size === 0) return [];

  const teamSeasonRows = db
    .select({ id: teamSeasons.id, franchiseId: teamSeasons.franchiseId, espnTeamId: teamSeasons.espnTeamId })
    .from(teamSeasons)
    .where(eq(teamSeasons.season, season))
    .all();
  const teamSeasonById = new Map(teamSeasonRows.map((t) => [t.id, t]));

  const franchiseNameById = new Map(db.select({ id: franchises.id, name: franchises.canonicalName }).from(franchises).all().map((f) => [f.id, f.name]));

  const byFranchise = new Map<number, FranchiseRosterContext>();
  for (const [teamSeasonId, matchupId] of matchupIdByTeamSeasonId) {
    const ts = teamSeasonById.get(teamSeasonId);
    if (!ts) continue;
    byFranchise.set(ts.franchiseId, {
      franchiseId: ts.franchiseId,
      franchiseName: franchiseNameById.get(ts.franchiseId) ?? `Franchise ${ts.franchiseId}`,
      matchupId,
      starters: [],
    });
  }

  const injuryByTeamPlayer = loadInjuryStatusByTeamPlayer(db, season, week);

  const rosterRows = db
    .select({ teamSeasonId: rosterSlots.teamSeasonId, playerId: rosterSlots.playerId, lineupSlot: rosterSlots.lineupSlot, playerName: players.fullName })
    .from(rosterSlots)
    .innerJoin(players, eq(rosterSlots.playerId, players.espnPlayerId))
    .where(and(eq(rosterSlots.season, season), eq(rosterSlots.week, week), eq(rosterSlots.isStarter, true)))
    .all();

  for (const row of rosterRows) {
    const ts = teamSeasonById.get(row.teamSeasonId);
    if (!ts || !matchupIdByTeamSeasonId.has(row.teamSeasonId)) continue;
    const ctx = byFranchise.get(ts.franchiseId);
    if (!ctx) continue; // seeded above for every not-final teamSeasonId; defensive only
    ctx.starters.push({
      playerId: row.playerId,
      playerName: row.playerName,
      lineupSlot: row.lineupSlot,
      injuryStatus: injuryByTeamPlayer.get(`${ts.espnTeamId}:${row.playerId}`) ?? null,
    });
  }

  return [...byFranchise.values()];
}

// ---------------------------------------------------------------------------
// Dedupe key helpers
// ---------------------------------------------------------------------------

function holeQualifier(hole: LineupHole): string {
  return hole.reason === "disqualified" ? String(hole.playerId) : String(hole.emptyIndex);
}

function detectedDedupeKey(franchiseId: number, season: number, week: number, hole: LineupHole): string {
  return `${DETECTED_PREFIX}${franchiseId}:${season}:${week}:${hole.slot}:${hole.reason}:${holeQualifier(hole)}`;
}

/** Derives the `LineupHoleResolved` key from an already-recorded `LineupHoleDetected` key — a
 * literal prefix swap, so the "same-key-derived" relationship the brief asks for is unambiguous. */
export function resolvedDedupeKeyFor(detectedKey: string): string {
  return detectedKey.startsWith(DETECTED_PREFIX) ? RESOLVED_PREFIX + detectedKey.slice(DETECTED_PREFIX.length) : detectedKey;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Detects the current lineup holes for `(season, week)` and diffs them into `events`: inserts a
 * `LineupHoleDetected` row for every hole not already recorded (dedupe key alone provides
 * idempotency — a re-run against unchanged state is a guaranteed no-op), and a `LineupHoleResolved`
 * row for every previously-detected, not-yet-resolved hole that is no longer present. Safe to call
 * on every hourly/live tick — see module docstring for the full scoping rules.
 */
export function emitLineupHoleEvents(db: Db, opts: EmitLineupHoleEventsOptions): EmitLineupHoleEventsResult {
  const { season, week } = opts;
  const now = opts.now ?? new Date();

  if (season < EMISSION_MIN_SEASON) return { inserted: 0 }; // SCOPING RULING — see module docstring

  const warnings: string[] = []; // resolveStartingSlotCounts wants a sink; not surfaced further —
  // a season whose settings can't be parsed safely yields zero "empty" holes (module docstring).
  const seasonRow = db.select({ settingsJson: seasons.settingsJson }).from(seasons).where(eq(seasons.season, season)).get();
  const startingSlotCounts = seasonRow ? (resolveStartingSlotCounts(season, seasonRow.settingsJson, warnings) ?? {}) : {};

  const franchiseContexts = loadFranchiseRosterContexts(db, season, week);
  // FIXED (fix round 1, finding 4 — was a KNOWN GAP/early-return here, self-disclosed in the
  // original Task 33 report): the resolve pass below must run EVERY tick regardless of whether
  // any franchise still has a non-final matchup, not just when `franchiseContexts` is non-empty.
  // The original early return (`if (franchiseContexts.length === 0) return { inserted: 0 };`)
  // meant that when EVERY franchise's matchup for this (season, week) went final in the SAME
  // tick, the function bailed out before ever reaching the resolve pass — any still-open holes
  // for the last franchise(s) to finish never got a `LineupHoleResolved` row at all. Deleting that
  // early return is sufficient and correct on its own: the detect loop below already does nothing
  // useful over an empty `franchiseContexts` (zero iterations, zero new candidates — exactly
  // right, since there's nothing to detect against), and the resolve pass reads `priorDetected`
  // independently from `events`, not from `franchiseContexts` — see the exact all-final-same-tick
  // test in `__tests__/lineup-holes.test.ts` for the regression case this now handles correctly
  // (every remaining open hole resolves with `resolvedReason: "matchup_final"`, since
  // `activeFranchiseIds` is correctly empty in that scenario).

  // resolvedReason derivation (see the resolve pass below): every franchise STILL in
  // `franchiseContexts` this tick still has a not-yet-final matchup (that's exactly what
  // `loadFranchiseRosterContexts` filters to) — so a previously-detected hole whose franchise is
  // in this set was resolved by the manager actually fixing it; a franchise that's fallen OUT of
  // this set (present in a prior tick, absent now — including the case where NO franchise is in
  // this set at all) dropped out because its matchup went final, not because anything got fixed.
  const activeFranchiseIds = new Set(franchiseContexts.map((c) => c.franchiseId));

  const candidateKeys = new Set<string>();
  const candidates: NewEvent[] = [];

  for (const ctx of franchiseContexts) {
    const holes = detectLineupHoles({ starters: ctx.starters, startingSlotCounts });
    for (const hole of holes) {
      const dedupeKey = detectedDedupeKey(ctx.franchiseId, season, week, hole);
      candidateKeys.add(dedupeKey);
      candidates.push({
        eventType: LINEUP_EVENT_TYPES.LINEUP_HOLE_DETECTED,
        season,
        week,
        occurredAt: now,
        detectedAt: now,
        franchiseId: ctx.franchiseId,
        matchupId: ctx.matchupId,
        playerId: hole.playerId,
        dedupeKey,
        payloadJson: {
          franchiseId: ctx.franchiseId,
          franchiseName: ctx.franchiseName,
          season,
          week,
          slot: hole.slot,
          reason: hole.reason,
          playerId: hole.playerId,
          playerName: hole.playerName,
          injuryStatus: hole.injuryStatus,
        },
      });
    }
  }

  // Resolve pass: previously-detected, still-unresolved holes for this (season, week) that are no
  // longer in the current candidate set — the one genuine "diff vs already-recorded events" step,
  // same shape as emit-events.ts's MatchupLeadChanged.
  const priorDetected = db
    .select({ dedupeKey: events.dedupeKey, franchiseId: events.franchiseId, matchupId: events.matchupId, playerId: events.playerId, payloadJson: events.payloadJson })
    .from(events)
    .where(and(eq(events.eventType, LINEUP_EVENT_TYPES.LINEUP_HOLE_DETECTED), eq(events.season, season), eq(events.week, week)))
    .all();

  const alreadyResolvedKeys = new Set(
    db
      .select({ dedupeKey: events.dedupeKey })
      .from(events)
      .where(and(eq(events.eventType, LINEUP_EVENT_TYPES.LINEUP_HOLE_RESOLVED), eq(events.season, season), eq(events.week, week)))
      .all()
      .map((r) => r.dedupeKey),
  );

  for (const prior of priorDetected) {
    const resolvedKey = resolvedDedupeKeyFor(prior.dedupeKey);
    if (alreadyResolvedKeys.has(resolvedKey)) continue; // never re-resolve — see module docstring's known limitation
    if (candidateKeys.has(prior.dedupeKey)) continue; // still present — not resolved

    // RESOLVED (UI wiring wave, Task 33 — was a TODO here since fix round 1, reviewer Minor
    // finding #3): distinguishes "the manager actually fixed the hole" from "the franchise's
    // matchup went final, so it's no longer a candidate and got implicitly resolved" — see
    // `activeFranchiseIds` above. Without this, an admin panel/ticker rendering "N holes resolved"
    // as a positive signal would misrepresent "moot" as "fixed."
    // `prior.franchiseId` is nullable per the `events` schema in general, but the detect pass
    // above always sets it (see `candidates.push` there) — a null here would only ever come from
    // hand-inserted test fixtures, never real detection, and is treated the same as "not active".
    const resolvedReason: "fixed" | "matchup_final" = prior.franchiseId !== null && activeFranchiseIds.has(prior.franchiseId) ? "fixed" : "matchup_final";

    const payload = prior.payloadJson as Record<string, unknown>;
    candidates.push({
      eventType: LINEUP_EVENT_TYPES.LINEUP_HOLE_RESOLVED,
      season,
      week,
      occurredAt: now,
      detectedAt: now,
      franchiseId: prior.franchiseId,
      matchupId: prior.matchupId,
      playerId: prior.playerId,
      dedupeKey: resolvedKey,
      payloadJson: { ...payload, resolvedAt: now.toISOString(), resolvedReason },
    });
  }

  if (candidates.length === 0) return { inserted: 0 };
  const result = db.insert(events).values(candidates).onConflictDoNothing({ target: events.dedupeKey }).run();
  return { inserted: result.changes };
}
