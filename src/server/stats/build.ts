/**
 * The stat-build orchestrator. Per AGENTS.md: derived stat tables are ALWAYS
 * fully rebuilt (never incremental) into their derived tables, tagged with
 * the `stat_builds.id` that produced them, and swapped in atomically inside
 * one transaction — readers never see a half-built state.
 *
 * - Stage 0 (canonical facts): per-season starting-slot counts, resolved
 *   from `settings_json.rosterSettings.lineupSlotCounts`; matchups,
 *   roster_slots, team_seasons, weeks loaded into memory.
 * - Stage 1 (`team_week`): one row per franchise per week they have a
 *   matchup entry. Score/result/margin come from the matchup. Optimal
 *   lineup/efficiency come from roster_slots via `src/engines/optimalLineup`
 *   — left NULL (never faked) whenever the matchup isn't final yet, the
 *   season's slot counts couldn't be parsed, or there's no roster_slots data
 *   at all for that team-week (true for every 2015-2017 week).
 * - Stage 2 (`allplay_week` + luck): all-play win/loss/tie and luck via
 *   `src/engines/allPlay` + `src/engines/luck`, regular-season weeks only —
 *   playoff weeks get `team_week` rows but no all-play rows.
 * - Stage 3 (chronological replay: `elo_history`, `franchise_elo`,
 *   `belt_reigns`, `belt_matches`): ONE pass over every completed
 *   head-to-head matchup via `src/engines/replay`. Feeds it champion
 *   detection (final playoff week's matchup whose winner has
 *   `final_standing` 1, falling back to the highest-scoring
 *   `WINNERS_BRACKET` matchup with a warning) and `app_settings` key
 *   `belt_overrides` (see `readBeltOverrides` for the documented shape).
 *   Also refines each matchup's week type from the coarse `weeks.week_type`
 *   (`regular`/`playoff` only, ever, in real data) using `matchups.
 *   playoff_tier` — `WINNERS_CONSOLATION_LADDER`/`LOSERS_CONSOLATION_LADDER`
 *   become `consolation` for Elo K-factor/streak-exclusion purposes, distinct
 *   from the real `WINNERS_BRACKET` playoff game in the SAME `playoff` week.
 * - Stage 4 (rollups: `season_stats`, `career_stats`, `record_entries`,
 *   `h2h_pairs`): aggregates stage 1-3 outputs via `src/engines/records` and
 *   `src/engines/h2h`.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import {
  allPlayWeek,
  buildH2HPairs,
  buildRecordEntries,
  CALIBRATION_POOLED_SLOT,
  computeAchievements,
  computeWeeklyBeatdowns,
  ELO_START,
  evaluateContextRules,
  optimalLineup,
  replay,
  RECORD_KEYS,
  weeklyLuck,
  type AchievementAward,
  type AchievementsBeltMatchInput,
  type AchievementsEloInput,
  type AchievementsRecordEntryInput,
  type AchievementsTeamWeekInput,
  type BeltReignOutput,
  type BeatdownAward,
  type ContextBeltMatchInput,
  type ContextBeltReignInput,
  type ContextH2HMatchupInput,
  type ContextRecordEntryInput,
  type ContextTeamWeekInput,
  type FranchiseStreakSummary,
  type H2HMatchupInput,
  type ReplayBeltOverride,
  type ReplayChampion,
  type ReplayMatchupInput,
  type ReplayResult,
  type ReplayWeekType,
  type RecordsBeltReignInput,
  type RecordsSeasonStatInput,
  type RecordsStreakInput,
  type RecordsTeamWeekInput,
} from "../../engines";
import type { Db } from "../db/client";
import {
  achievements,
  allplayWeek,
  appSettings,
  beltMatches,
  beltReigns,
  careerStats,
  contextNotes,
  eloHistory,
  franchiseElo,
  franchises,
  h2hPairs,
  matchups,
  recordEntries,
  rosterSlots,
  seasonStats,
  seasons,
  slotScoringStats,
  statBuilds,
  teamSeasons,
  teamWeek,
  weeks,
  type Matchup,
  type NewAchievementRow,
  type NewAllplayWeek,
  type NewBeltMatch,
  type NewBeltReign,
  type NewCareerStat,
  type NewContextNoteRow,
  type NewEloHistory,
  type NewFranchiseElo,
  type NewH2HPair,
  type NewRecordEntry,
  type NewSeasonStat,
  type NewSlotScoringStat,
  type NewTeamWeek,
  type RosterSlot,
  type Season,
  type TeamSeason,
  type Week,
} from "../db/schema";
import { LINEUP_SLOT_MAP } from "../espn/constants";

export interface RunStatBuildOptions {
  force?: boolean;
}

export interface BuildRowCounts {
  teamWeek: number;
  allplayWeek: number;
  eloHistory: number;
  franchiseElo: number;
  beltReigns: number;
  beltMatches: number;
  seasonStats: number;
  careerStats: number;
  recordEntries: number;
  h2hPairs: number;
  contextNotes: number;
  achievements: number;
  slotScoringStats: number;
}

const EMPTY_ROW_COUNTS: BuildRowCounts = {
  teamWeek: 0,
  allplayWeek: 0,
  eloHistory: 0,
  franchiseElo: 0,
  beltReigns: 0,
  beltMatches: 0,
  seasonStats: 0,
  careerStats: 0,
  recordEntries: 0,
  h2hPairs: 0,
  contextNotes: 0,
  achievements: 0,
  slotScoringStats: 0,
};

export interface BuildResult {
  status: "ok" | "skipped" | "failed";
  /** The relevant `stat_builds.id` — the build that ran, or (when skipped) the last 'ok' build. */
  buildId: number | null;
  durationMs: number | null;
  rowCounts: BuildRowCounts;
  warnings: string[];
  errorText?: string;
}

const INSERT_CHUNK_SIZE = 500; // keeps bound-parameter counts well under SQLite's ~32766 limit

/** BE(20)/IR(21) are the only non-starting slot ids — dropped from starting-slot counts. */
const BENCH_SLOT_IDS = new Set([20, 21]);

export function runStatBuild(db: Db, opts?: RunStatBuildOptions): BuildResult {
  // `Db` (`BetterSQLite3Database<Schema>`) doesn't type `$client` — drizzle() adds it via an
  // intersection type on its return value, not on the class itself. It's there at runtime for
  // both `getDb()` and `createDb()` (see src/server/db/client.ts), so this cast is safe.
  const sqlite = (db as unknown as { $client: Database.Database }).$client;
  const force = opts?.force ?? false;
  const inputHash = computeInputHash(sqlite);

  if (!force) {
    const lastOk = db
      .select()
      .from(statBuilds)
      .where(eq(statBuilds.status, "ok"))
      .orderBy(desc(statBuilds.id))
      .limit(1)
      .all()[0];
    if (lastOk && lastOk.inputHash === inputHash) {
      return {
        status: "skipped",
        buildId: lastOk.id,
        durationMs: null,
        rowCounts: EMPTY_ROW_COUNTS,
        warnings: [],
      };
    }
  }

  const startedAt = new Date();
  const buildRow = db.insert(statBuilds).values({ startedAt, inputHash, status: "running" }).returning().get();
  const buildId = buildRow.id;

  const warnings: string[] = [];

  try {
    const { teamWeekRows, allplayWeekRows } = computeDerivedRows(db, buildId, warnings);
    const stage34 = computeStage34Rows(db, buildId, teamWeekRows, allplayWeekRows, warnings);
    const contextNoteRows = stage34.contextNoteRows;
    const achievementRows = computeAchievementRows(
      db,
      buildId,
      teamWeekRows,
      stage34.beltMatchRows,
      stage34.eloHistoryRows,
      stage34.recordEntryRows,
    );
    const slotScoringStatsRows = computeSlotScoringStatsRows(db, buildId);

    let rowCounts: BuildRowCounts = EMPTY_ROW_COUNTS;

    db.transaction((tx) => {
      tx.delete(teamWeek).run();
      tx.delete(allplayWeek).run();
      tx.delete(eloHistory).run();
      tx.delete(franchiseElo).run();
      tx.delete(beltMatches).run();
      tx.delete(beltReigns).run();
      tx.delete(recordEntries).run();
      tx.delete(h2hPairs).run();
      tx.delete(careerStats).run();
      tx.delete(seasonStats).run();
      tx.delete(contextNotes).run();
      tx.delete(achievements).run();
      tx.delete(slotScoringStats).run();

      for (const rows of chunk(teamWeekRows, INSERT_CHUNK_SIZE)) tx.insert(teamWeek).values(rows).run();
      for (const rows of chunk(allplayWeekRows, INSERT_CHUNK_SIZE)) tx.insert(allplayWeek).values(rows).run();
      for (const rows of chunk(stage34.eloHistoryRows, INSERT_CHUNK_SIZE)) tx.insert(eloHistory).values(rows).run();
      for (const rows of chunk(stage34.franchiseEloRows, INSERT_CHUNK_SIZE)) tx.insert(franchiseElo).values(rows).run();
      // belt_reigns before belt_matches has no FK ordering requirement (belt_matches references
      // matchups/franchises, not belt_reigns), but season_stats must exist before career_stats
      // only conceptually (no FK) — order here just mirrors the pipeline's dependency order.
      for (const rows of chunk(stage34.beltReignRows, INSERT_CHUNK_SIZE)) tx.insert(beltReigns).values(rows).run();
      for (const rows of chunk(stage34.beltMatchRows, INSERT_CHUNK_SIZE)) tx.insert(beltMatches).values(rows).run();
      for (const rows of chunk(stage34.seasonStatsRows, INSERT_CHUNK_SIZE)) tx.insert(seasonStats).values(rows).run();
      for (const rows of chunk(stage34.careerStatsRows, INSERT_CHUNK_SIZE)) tx.insert(careerStats).values(rows).run();
      for (const rows of chunk(stage34.recordEntryRows, INSERT_CHUNK_SIZE)) tx.insert(recordEntries).values(rows).run();
      for (const rows of chunk(stage34.h2hPairRows, INSERT_CHUNK_SIZE)) tx.insert(h2hPairs).values(rows).run();
      // Stage 5 last — purely derived from stage 1-4's already-computed in-memory rows, no
      // ordering dependency of its own (context_notes carries no FK other than build_id).
      for (const rows of chunk(contextNoteRows, INSERT_CHUNK_SIZE)) tx.insert(contextNotes).values(rows).run();
      // Stage 6 — same "no ordering dependency of its own" reasoning as stage 5 (achievements
      // carries no FK other than build_id, purely derived from stage 1-4's already-computed rows).
      for (const rows of chunk(achievementRows, INSERT_CHUNK_SIZE)) tx.insert(achievements).values(rows).run();
      // Stage 7 (Task 32) — reads roster_slots directly (see computeSlotScoringStatsRows), no
      // dependency on any other stage's output either.
      for (const rows of chunk(slotScoringStatsRows, INSERT_CHUNK_SIZE)) tx.insert(slotScoringStats).values(rows).run();

      const finishedAt = new Date();
      tx.update(statBuilds)
        .set({ status: "ok", finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime() })
        .where(eq(statBuilds.id, buildId))
        .run();

      rowCounts = {
        teamWeek: teamWeekRows.length,
        allplayWeek: allplayWeekRows.length,
        eloHistory: stage34.eloHistoryRows.length,
        franchiseElo: stage34.franchiseEloRows.length,
        beltReigns: stage34.beltReignRows.length,
        beltMatches: stage34.beltMatchRows.length,
        seasonStats: stage34.seasonStatsRows.length,
        contextNotes: contextNoteRows.length,
        careerStats: stage34.careerStatsRows.length,
        slotScoringStats: slotScoringStatsRows.length,
        recordEntries: stage34.recordEntryRows.length,
        h2hPairs: stage34.h2hPairRows.length,
        achievements: achievementRows.length,
      };
    });

    const finishedRow = db.select().from(statBuilds).where(eq(statBuilds.id, buildId)).get()!;

    return {
      status: "ok",
      buildId,
      durationMs: finishedRow.durationMs ?? null,
      rowCounts,
      warnings,
    };
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    const finishedAt = new Date();
    // Outside the failed transaction (which already rolled back) — this is a fresh statement
    // updating the 'running' row inserted above so the failure is recorded, not silently lost.
    db.update(statBuilds)
      .set({ status: "failed", errorText, finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime() })
      .where(eq(statBuilds.id, buildId))
      .run();

    return {
      status: "failed",
      buildId,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      rowCounts: EMPTY_ROW_COUNTS,
      warnings,
      errorText,
    };
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Input-hash change detection
// ---------------------------------------------------------------------------

/**
 * DESIGN GAP CLOSED (Task 17, per the ledger note): every digest component below detects DATA
 * changes (source tables) — nothing previously detected a CODE-only change (a new/changed rule
 * in `src/engines/context.ts` or `src/engines/records.ts`, a rewritten aggregation in this file,
 * etc.). Task 8's fix round 4 and every task since worked around this by telling the controller to
 * `stats:build -- --force` once after landing. This constant closes that gap: bump it by 1 any
 * time a stage 0-5 CODE change should force a rebuild even though no source TABLE changed — folded
 * into `computeInputHash` below, so a bump alone (no data touched at all) makes the next build's
 * hash differ from the last 'ok' build's stored hash, and it reruns without `--force`.
 *
 * Landing this constant for the FIRST time (this task) already forces exactly one such rebuild on
 * its own — no prior build's stored hash could possibly have included it — so Task 17's own
 * `beatdown_of_week` rule/columns take effect on the controller's next `stats:build` run
 * automatically, with no manual `--force` needed this time. Future code-only changes: bump this.
 *
 * TASK 26: stage 6 (`achievements`, src/engines/achievements.ts) is pure new CODE — every input
 * it reads (team_week, belt_matches, elo_history, record_entries, plus its own fresh `matchups`
 * read for the settlement gate) is already sourced from tables `DIGEST_TABLES`/the dedicated
 * content-hash helpers below cover, so no source TABLE this build reads is new. Bumped anyway
 * (1 -> 2) so the very first build to include achievements runs automatically on the next
 * `stats:build`, same reasoning as the `beatdown_of_week` bump above.
 *
 * TASK 32: stage 7 (`slot_scoring_stats`, feeding src/engines/winProbability.ts) is also pure new
 * CODE reading an already-digested source table (`roster_slots` — its aggregate is
 * `COALESCE(SUM(points),0)` in `DIGEST_TABLES` below, which already changes whenever a roster
 * row's points changes, and a full re-normalize also changes `roster_slots`' row count/max rowid).
 * No NEW source table is read. Bumped anyway (2 -> 3), same reasoning as the two bumps above: the
 * very first build to include slot_scoring_stats needs to run automatically on the next
 * `stats:build`, not require a manual `--force`.
 */
const STAT_ENGINE_VERSION = 3;

/**
 * Per source table: row count + max rowid + a cheap content aggregate, so real data changes (not
 * just row churn) are detected.
 *
 * `matchups` digests `is_final` alongside the scores so a future non-renormalize write path that
 * flips a matchup from unfinished to final — without changing its score — can't be missed either.
 *
 * `seasons` is NOT here — see `hashSeasonsContent` below. `seasons.season` (the literal season
 * integer) is its own primary key, so `normalizeSeason`'s delete+reinsert during a re-normalize
 * does NOT bump `max(rowid)` the way every other digested table's autoincrement surrogate key
 * does, and a numeric SQL aggregate over its JSON columns is a weak substitute: a
 * `COALESCE(SUM(length(settings_json)),0)`-style digest was tried first and is provably
 * insufficient — verified against real data that correcting `lineupSlotCounts` by swapping one
 * digit for another same-width digit (e.g. `RB:2 -> RB:3`, `FLEX:1 -> FLEX:0`) changes the JSON
 * content but leaves its string length identical, so a length-based digest misses it too.
 */
const DIGEST_TABLES: { table: string; aggregate: string }[] = [
  { table: "matchups", aggregate: "COALESCE(SUM(home_score),0) + COALESCE(SUM(away_score),0) + COALESCE(SUM(is_final),0)" },
  { table: "roster_slots", aggregate: "COALESCE(SUM(points),0)" },
  // final_standing/made_playoffs added for stage 3-4 (Task 8): champion/sacko detection and
  // belt/records championship-matchup detection now depend on final_standing, not just
  // points_for — same hardening as matchups.is_final above, before a review has to catch it.
  { table: "team_seasons", aggregate: "COALESCE(SUM(points_for),0) + COALESCE(SUM(final_standing),0) + COALESCE(SUM(made_playoffs),0)" },
  { table: "corrections", aggregate: "COALESCE(SUM(id),0)" },
];

/**
 * Hashes every season row's actual `settings_json`/`scoring_json`/`playoff_format_json` TEXT
 * content directly, rather than summarizing it numerically in SQL — closes the collision gap
 * documented on `DIGEST_TABLES` above for good. `seasons` is tiny (~12 rows in the real league),
 * so pulling the full JSON text for every row is cheap. Ordered by `season` for determinism.
 */
function hashSeasonsContent(sqlite: Database.Database, hash: ReturnType<typeof createHash>): void {
  const rows = sqlite
    .prepare(`SELECT season, settings_json, scoring_json, playoff_format_json FROM seasons ORDER BY season`)
    .all() as { season: number; settings_json: string; scoring_json: string; playoff_format_json: string }[];
  hash.update(`seasons_content_row_count:${rows.length}\n`);
  for (const s of rows) {
    hash.update(`seasons_content:${s.season}:${s.settings_json}:${s.scoring_json}:${s.playoff_format_json}\n`);
  }
}

/**
 * Stage 3-4 (Task 8) reads `app_settings` key `belt_overrides` — a NEW input Stage 0-2 never
 * touched. `app_settings.key` is a literal TEXT primary key (same shape of problem as `seasons`:
 * an `onConflictDoUpdate` upsert never bumps `rowid`), so its content is hashed directly here
 * too, for every key (not just `belt_overrides`) — cheap (a handful of rows) and robust against
 * any future stage that reads a different key without remembering to extend this digest.
 */
function hashAppSettingsContent(sqlite: Database.Database, hash: ReturnType<typeof createHash>): void {
  const rows = sqlite.prepare(`SELECT key, value_json FROM app_settings ORDER BY key`).all() as { key: string; value_json: string }[];
  hash.update(`app_settings_content_row_count:${rows.length}\n`);
  for (const r of rows) {
    hash.update(`app_settings_content:${r.key}:${r.value_json}\n`);
  }
}

/**
 * Stage 3-4 (Task 8) reads `matchups.playoff_tier` — via `classifyMatchupWeekType` (Elo K-factor,
 * belt-at-stake inclusion, streak/h2h exclusion) and `detectChampionships` (the `WINNERS_BRACKET`
 * fallback) — a NEW dependency on a column `DIGEST_TABLES`' `matchups` numeric aggregate
 * (scores + `is_final`) never covered. `matchups` rows DO get fresh autoincrement ids on every
 * re-normalize (unlike `seasons`/`app_settings`), so `max(rowid)` alone would catch a full
 * re-normalize — but the same class of gap as Task 6's C1 applies to any narrower, direct
 * correction of just this one column (e.g. a future `corrections`-only playoff-tier fix that
 * doesn't touch scores). Confirmed empirically: mutating `playoff_tier` alone, nothing else,
 * left a rebuild skipped before this hash existed. `matchups` is ~1031 rows in the real league —
 * still cheap to hash row-by-row directly, same pattern as `hashSeasonsContent`.
 */
function hashMatchupsPlayoffTierContent(sqlite: Database.Database, hash: ReturnType<typeof createHash>): void {
  const rows = sqlite.prepare(`SELECT id, playoff_tier FROM matchups ORDER BY id`).all() as { id: number; playoff_tier: string | null }[];
  hash.update(`matchups_playoff_tier_row_count:${rows.length}\n`);
  for (const r of rows) {
    hash.update(`matchups_playoff_tier:${r.id}:${r.playoff_tier ?? " NULL"}\n`);
  }
}

/**
 * Stage 5 (Task 12, fix round 1 I2) reads `franchises.canonical_name` — baked verbatim into
 * `context_notes.rendered_text` for h2h_milestone/belt_stakes/career_milestone notes.
 * `franchises.id` is an autoincrement surrogate, but a RENAME (`UPDATE franchises SET
 * canonical_name = ...` on an existing row) changes neither the row count nor `max(rowid)` — the
 * same blind spot `hashSeasonsContent`/`hashAppSettingsContent`/`hashMatchupsPlayoffTierContent`
 * above already exist to close, just on a different table. No stage before 5 ever needed
 * franchise NAMES (only ids, as opaque identifiers threaded through Elo/belt/streaks/records/h2h)
 * — every page that displays a name does a live JOIN against `franchises` at render time,
 * independent of the stat-build pipeline, so this genuinely never mattered before context_notes
 * started storing pre-rendered text. Confirmed as a live, not hypothetical, case: the controller's
 * own real "AB Kills  Billy" -> "AB Kills Billy" canonicalName correction is exactly this shape of
 * change. Hashed row-by-row directly, same pattern as the others — `franchises` is ~19 rows in the
 * real league, trivially cheap.
 */
function hashFranchisesContent(sqlite: Database.Database, hash: ReturnType<typeof createHash>): void {
  const rows = sqlite.prepare(`SELECT id, canonical_name FROM franchises ORDER BY id`).all() as { id: number; canonical_name: string }[];
  hash.update(`franchises_content_row_count:${rows.length}\n`);
  for (const r of rows) {
    hash.update(`franchises_content:${r.id}:${r.canonical_name}\n`);
  }
}

function computeInputHash(sqlite: Database.Database): string {
  const hash = createHash("sha256");
  hash.update(`engine_version:${STAT_ENGINE_VERSION}\n`);
  for (const { table, aggregate } of DIGEST_TABLES) {
    const row = sqlite
      .prepare(`SELECT COUNT(*) as cnt, COALESCE(MAX(rowid), 0) as maxRowid, ${aggregate} as agg FROM ${table}`)
      .get() as { cnt: number; maxRowid: number; agg: number };
    hash.update(`${table}:${row.cnt}:${row.maxRowid}:${row.agg}\n`);
  }
  hashSeasonsContent(sqlite, hash);
  hashAppSettingsContent(sqlite, hash);
  hashMatchupsPlayoffTierContent(sqlite, hash);
  hashFranchisesContent(sqlite, hash);
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Stage 0 — canonical facts
// ---------------------------------------------------------------------------

/**
 * Maps `settings_json.rosterSettings.lineupSlotCounts` (id -> count) to
 * label -> count for STARTING slots only (BE/IR dropped, 0-counts dropped).
 * `null` means the season's settings couldn't be parsed at all — callers
 * must skip efficiency entirely for that season rather than guess.
 *
 * Exported (Task 20) for `src/server/sync/lineup-holes.ts`, which reuses this EXACT derivation for
 * its "how many starters SHOULD this slot label have" question — so optimal-lineup efficiency and
 * lineup-hole detection can never disagree about what a full lineup looks like.
 */
export function resolveStartingSlotCounts(season: number, settingsJson: unknown, warnings: string[]): Record<string, number> | null {
  const rosterSettings = (settingsJson as { rosterSettings?: { lineupSlotCounts?: unknown } } | null | undefined)
    ?.rosterSettings;
  const raw = rosterSettings?.lineupSlotCounts;
  if (!raw || typeof raw !== "object") {
    warnings.push(
      `season ${season}: settings_json.rosterSettings.lineupSlotCounts missing/unparseable — efficiency skipped for this season`,
    );
    return null;
  }

  const counts: Record<string, number> = {};
  for (const [idStr, countRaw] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(idStr);
    if (!Number.isFinite(id) || BENCH_SLOT_IDS.has(id)) continue;
    const count = typeof countRaw === "number" ? countRaw : Number(countRaw);
    if (!Number.isFinite(count) || count <= 0) continue;
    const label = LINEUP_SLOT_MAP[id];
    if (!label) {
      warnings.push(`season ${season}: lineupSlotCounts has unmapped slot id ${id}, dropped`);
      continue;
    }
    counts[label] = (counts[label] ?? 0) + count;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Stage 1 + 2 — team_week / allplay_week
// ---------------------------------------------------------------------------

interface TeamWeekCandidate {
  row: NewTeamWeek;
  /** Internal only (not a team_week column) — gates stage-2 all-play inclusion. */
  isFinal: boolean;
}

interface DerivedRows {
  teamWeekRows: NewTeamWeek[];
  allplayWeekRows: NewAllplayWeek[];
}

function computeDerivedRows(db: Db, buildId: number, warnings: string[]): DerivedRows {
  const seasonRows = db.select().from(seasons).all();
  const teamSeasonRows = db.select().from(teamSeasons).all();
  const matchupRows = db.select().from(matchups).all();
  const weekRows = db.select().from(weeks).all();
  const rosterRows = db.select().from(rosterSlots).all();

  const teamSeasonById = new Map<number, TeamSeason>(teamSeasonRows.map((t) => [t.id, t]));
  const weekByKey = new Map<string, Week>(weekRows.map((w) => [`${w.season}:${w.week}`, w]));

  const rosterByTeamWeek = new Map<string, RosterSlot[]>();
  for (const r of rosterRows) {
    const key = `${r.teamSeasonId}:${r.week}`;
    const list = rosterByTeamWeek.get(key);
    if (list) list.push(r);
    else rosterByTeamWeek.set(key, [r]);
  }

  const slotCountsBySeason = new Map<number, Record<string, number> | null>();
  for (const s of seasonRows) {
    slotCountsBySeason.set(s.season, resolveStartingSlotCounts(s.season, s.settingsJson, warnings));
  }

  const candidates: TeamWeekCandidate[] = [];
  for (const m of matchupRows) {
    candidates.push(...buildTeamWeekCandidates(m, weekByKey, teamSeasonById, rosterByTeamWeek, slotCountsBySeason, buildId, warnings));
  }

  const teamWeekRows = candidates.map((c) => c.row);
  const allplayWeekRows = buildAllplayWeekRows(candidates, buildId);

  return { teamWeekRows, allplayWeekRows };
}

function buildTeamWeekCandidates(
  m: Matchup,
  weekByKey: Map<string, Week>,
  teamSeasonById: Map<number, TeamSeason>,
  rosterByTeamWeek: Map<string, RosterSlot[]>,
  slotCountsBySeason: Map<number, Record<string, number> | null>,
  buildId: number,
  warnings: string[],
): TeamWeekCandidate[] {
  const weekMeta = weekByKey.get(`${m.season}:${m.week}`);
  const weekType = weekMeta?.weekType ?? "regular";
  if (!weekMeta) {
    warnings.push(
      `season ${m.season} week ${m.week}: matchup ${m.id} has no corresponding weeks row — defaulted week_type to 'regular'`,
    );
  }

  const sides: { teamSeasonId: number; opponentTeamSeasonId: number | null; score: number; opponentScore: number; projected: number | null; isHome: boolean }[] = [
    {
      teamSeasonId: m.homeTeamSeasonId,
      opponentTeamSeasonId: m.awayTeamSeasonId,
      score: m.homeScore,
      opponentScore: m.awayScore,
      projected: m.homeProjected,
      isHome: true,
    },
  ];
  if (m.awayTeamSeasonId !== null) {
    sides.push({
      teamSeasonId: m.awayTeamSeasonId,
      opponentTeamSeasonId: m.homeTeamSeasonId,
      score: m.awayScore,
      opponentScore: m.homeScore,
      projected: m.awayProjected,
      isHome: false,
    });
  }

  const out: TeamWeekCandidate[] = [];

  for (const side of sides) {
    const teamSeason = teamSeasonById.get(side.teamSeasonId);
    if (!teamSeason) {
      warnings.push(`season ${m.season} week ${m.week}: matchup ${m.id} references team_season ${side.teamSeasonId} with no row, skipped`);
      continue;
    }
    const opponentTeamSeason = side.opponentTeamSeasonId !== null ? teamSeasonById.get(side.opponentTeamSeasonId) : undefined;
    const opponentFranchiseId = opponentTeamSeason ? opponentTeamSeason.franchiseId : null;

    let result: "W" | "L" | "T" | null = null;
    if (m.isFinal && opponentFranchiseId !== null) {
      if (m.winner === "tie") result = "T";
      else if (m.winner === "home") result = side.isHome ? "W" : "L";
      else if (m.winner === "away") result = side.isHome ? "L" : "W";
    }

    const margin = opponentFranchiseId !== null ? side.score - side.opponentScore : null;

    const efficiencyFields = m.isFinal
      ? computeEfficiencyFields(m.season, m.week, side.teamSeasonId, side.score, rosterByTeamWeek, slotCountsBySeason, warnings)
      : { optimalScore: null, benchPointsLeft: null, efficiency: null, eligibilityFallback: false };

    out.push({
      isFinal: m.isFinal,
      row: {
        buildId,
        season: m.season,
        week: m.week,
        weekType,
        teamSeasonId: side.teamSeasonId,
        franchiseId: teamSeason.franchiseId,
        opponentFranchiseId,
        matchupId: m.id,
        score: side.score,
        projected: side.projected,
        result,
        margin,
        ...efficiencyFields,
      },
    });
  }

  return out;
}

interface EfficiencyFields {
  optimalScore: number | null;
  benchPointsLeft: number | null;
  efficiency: number | null;
  eligibilityFallback: boolean;
}

function computeEfficiencyFields(
  season: number,
  week: number,
  teamSeasonId: number,
  score: number,
  rosterByTeamWeek: Map<string, RosterSlot[]>,
  slotCountsBySeason: Map<number, Record<string, number> | null>,
  warnings: string[],
): EfficiencyFields {
  const rosterForWeek = rosterByTeamWeek.get(`${teamSeasonId}:${week}`) ?? [];
  const slotCounts = slotCountsBySeason.get(season) ?? null;

  // No bench data at all (2015-2017: matchups exist, roster_slots don't) or the season's slot
  // counts couldn't be parsed — never fake efficiency in either case.
  if (rosterForWeek.length === 0 || slotCounts === null) {
    return { optimalScore: null, benchPointsLeft: null, efficiency: null, eligibilityFallback: false };
  }

  const nonIr = rosterForWeek.filter((r) => r.lineupSlot !== "IR");
  let fallbackUsed = false;
  const players = nonIr.map((r) => {
    const eligible = Array.isArray(r.eligibleSlotsJson) ? (r.eligibleSlotsJson as unknown[]).filter((s): s is string => typeof s === "string") : [];
    if (eligible.length === 0) {
      fallbackUsed = true;
      return { id: r.playerId, points: r.points, eligibleSlots: [r.lineupSlot] };
    }
    return { id: r.playerId, points: r.points, eligibleSlots: eligible };
  });

  const lineup = optimalLineup(players, slotCounts, { usedFallback: fallbackUsed });
  const optimalScore = lineup.optimalScore;

  const diff = optimalScore - score;
  let benchPointsLeft: number;
  if (diff < 0 && diff > -0.01) {
    benchPointsLeft = 0; // rounding-tolerance clamp
  } else {
    benchPointsLeft = diff;
    if (diff < -0.01) {
      warnings.push(
        `season ${season} week ${week} team_season ${teamSeasonId}: optimal_score (${optimalScore}) < actual score (${score}) by ${(-diff).toFixed(2)} — data quality issue`,
      );
    }
  }

  const efficiency = optimalScore === 0 ? 1 : score / optimalScore;

  return { optimalScore, benchPointsLeft, efficiency, eligibilityFallback: lineup.usedFallback };
}

function buildAllplayWeekRows(candidates: TeamWeekCandidate[], buildId: number): NewAllplayWeek[] {
  const byWeek = new Map<string, TeamWeekCandidate[]>();
  for (const c of candidates) {
    if (c.row.weekType !== "regular" || !c.isFinal) continue; // playoff weeks get team_week rows, no all-play
    const key = `${c.row.season}:${c.row.week}`;
    const list = byWeek.get(key);
    if (list) list.push(c);
    else byWeek.set(key, [c]);
  }

  const out: NewAllplayWeek[] = [];
  for (const list of byWeek.values()) {
    const first = list[0]!.row;
    const scores = list.map((c) => ({ franchiseId: c.row.franchiseId, score: c.row.score }));
    const results = allPlayWeek(scores);
    const resultByFranchise = new Map(results.map((r) => [r.franchiseId, r]));
    const opponents = list.length - 1;

    for (const c of list) {
      const ap = resultByFranchise.get(c.row.franchiseId)!;
      let luckScore: number | null = null;
      if (c.row.result !== null && opponents > 0) {
        const resultNum = c.row.result === "W" ? 1 : c.row.result === "T" ? 0.5 : 0;
        const allPlayWins = ap.wins + 0.5 * ap.ties;
        luckScore = weeklyLuck({ result: resultNum, allPlayWins, opponents, margin: Math.abs(c.row.margin ?? 0) });
      }

      out.push({
        buildId,
        season: first.season,
        week: first.week,
        franchiseId: c.row.franchiseId,
        wins: ap.wins,
        losses: ap.losses,
        ties: ap.ties,
        luckScore,
      });
    }
  }

  return out;
}

/**
 * RULING (fix round 2, C1 mid-season case): SEASON-scope record keys (highest/lowest_season_
 * total, best/worst_season_record, most_season_points_against) must only draw from a genuinely
 * COMPLETE season — a partial season total (e.g. 2026 after week 1) must never rank, high or low,
 * next to a full season's worth of points.
 *
 * FIX ROUND 3: the original fallback here ("every matchup ROW currently in the DB for this
 * season is final") is itself unsound and was DROPPED, not just demoted — ESPN doesn't create
 * playoff-week `schedule[]`/matchup rows until bracket seeding is set, so a season that's just
 * finished its entire regular season (all EXISTING rows final) but hasn't had its playoffs seeded
 * yet would pass that check three weeks early. Confirmed empirically: real 2026 currently has
 * exactly 84 rows (14 reg weeks x 6 matchups), zero playoff rows — this is not hypothetical, the
 * real season will pass through exactly this state in December.
 *
 * `seasons.status` is now the primary signal (normalize.ts's `deriveSeasonStatus` was fixed at
 * the source to confirm against ESPN's own `status.latestScoringPeriod >= finalScoringPeriod`
 * before ever calling a season 'complete' — see normalize.ts). But `status !== 'complete'` alone
 * is not trusted as SUFFICIENT here either, only necessary: `data/league.db`'s ALREADY-NORMALIZED
 * `seasons.status` values were computed by the OLD (pre-fix) derivation until the next real
 * re-normalize runs, so a stale 'complete' could still be sitting in the database this build reads
 * from RIGHT NOW. Defense in depth: additionally require structural evidence this season's
 * playoffs were actually reached and finished — at least one `weeks.week_type = 'playoff'` row
 * exists for the season with every one of ITS matchups final — UNLESS the season's own
 * configuration shows it genuinely has no playoff round at all (see
 * `genuinelyNoPlayoffsConfigured`), which is inferred and logged, never assumed silently.
 */

/**
 * True only when this season's OWN configured schedule structure shows no playoff round exists at
 * all — NOT merely "no playoff rows exist in the DB yet" (that's ambiguous; see the caller). Real
 * ESPN `settings.scheduleSettings` (stored verbatim as `playoff_format_json`) carries a
 * `matchupPeriods` map keyed by every scoring period the FULL season will ever use, known from day
 * one regardless of how many `weeks`/`matchups` rows have been created so far. If its highest key
 * doesn't extend past `reg_season_weeks`, no playoff period is configured; if it does (confirmed
 * against every real archived season), a playoff round is expected even before any playoff-week
 * row exists.
 */
function genuinelyNoPlayoffsConfigured(s: Season, warnings: string[]): boolean {
  const playoffFormat = s.playoffFormatJson as { matchupPeriods?: unknown } | null | undefined;
  const matchupPeriods = playoffFormat?.matchupPeriods;
  if (matchupPeriods && typeof matchupPeriods === "object" && !Array.isArray(matchupPeriods)) {
    const periodKeys = Object.keys(matchupPeriods)
      .map(Number)
      .filter((n) => Number.isFinite(n));
    if (periodKeys.length > 0) {
      const maxConfiguredPeriod = Math.max(...periodKeys);
      return maxConfiguredPeriod <= s.regSeasonWeeks;
    }
  }
  // Defensive fallback only — every real archived season carries a parseable matchupPeriods map
  // (see docstring). Without it, there's no configuration signal to trust either way; default to
  // "playoffs ARE expected" (the safer direction — never fabricates season-scope eligibility) and
  // say so.
  warnings.push(
    `season ${s.season}: playoff_format_json has no parseable matchupPeriods map — cannot confirm whether a ` +
      `playoff round is configured; defaulting to "playoffs expected" (the safer direction)`,
  );
  return false;
}

function computeSeasonCompleteBySeason(seasonRows: Season[], weekRows: Week[], matchupRows: Matchup[], warnings: string[]): Map<number, boolean> {
  const weeksBySeason = new Map<number, Week[]>();
  for (const w of weekRows) {
    const list = weeksBySeason.get(w.season) ?? [];
    list.push(w);
    weeksBySeason.set(w.season, list);
  }
  const matchupsBySeason = new Map<number, Matchup[]>();
  for (const m of matchupRows) {
    const list = matchupsBySeason.get(m.season) ?? [];
    list.push(m);
    matchupsBySeason.set(m.season, list);
  }

  const result = new Map<number, boolean>();
  for (const s of seasonRows) {
    if (s.status !== "complete") {
      result.set(s.season, false);
      continue;
    }

    const seasonWeeks = weeksBySeason.get(s.season) ?? [];
    const seasonMatchups = matchupsBySeason.get(s.season) ?? [];
    const playoffWeekNumbers = new Set(seasonWeeks.filter((w) => w.weekType === "playoff").map((w) => w.week));

    if (playoffWeekNumbers.size > 0) {
      const playoffMatchups = seasonMatchups.filter((m) => playoffWeekNumbers.has(m.week));
      const allPlayoffMatchupsFinal = playoffMatchups.length > 0 && playoffMatchups.every((m) => m.isFinal);
      result.set(s.season, allPlayoffMatchupsFinal);
      if (!allPlayoffMatchupsFinal) {
        warnings.push(
          `season ${s.season}: status is 'complete' but not every playoff-week matchup is final yet — season-scope records withheld until it genuinely is (this database's normalized status may be stale; a re-normalize would refresh it)`,
        );
      }
      continue;
    }

    // No playoff-type week is recorded for this season at all. Could genuinely be a schedule with
    // no playoff round configured, or could be exactly the boundary case this function exists to
    // catch (playoff weeks not seeded as rows yet — and CRITICALLY, comparing against how many
    // weeks currently HAVE rows can't tell these two apart: both look identical, "only regular-
    // season weeks exist so far"). Infer which from the season's CONFIGURED schedule structure
    // instead, which is known from day one regardless of how many rows exist yet: real ESPN
    // `settings.scheduleSettings` (stored verbatim as `playoff_format_json`) carries a
    // `matchupPeriods` map keyed by every period the FULL season will ever use — confirmed against
    // real archived data that this already lists periods beyond `matchupPeriodCount` (regSeasonWeeks)
    // for a season with playoffs (e.g. real 2026, pre-season: keys 1-17 vs regSeasonWeeks=14),
    // while a schedule with no playoff round at all would have its highest key match
    // regSeasonWeeks exactly.
    if (genuinelyNoPlayoffsConfigured(s, warnings)) {
      warnings.push(
        `season ${s.season}: status is 'complete' with no playoff-type weeks recorded — inferred this season's schedule has no playoff round configured (playoff_format_json's matchupPeriods never extends past reg_season_weeks=${s.regSeasonWeeks}), so season-scope records are eligible`,
      );
      result.set(s.season, true);
    } else {
      warnings.push(
        `season ${s.season}: status is 'complete' but no playoff-type weeks are recorded yet, and this season's schedule configuration shows a playoff round IS expected — treating as NOT complete for season-scope record purposes (mid-boundary: regular season done, playoffs not seeded as rows yet; this database's normalized status may be stale)`,
      );
      result.set(s.season, false);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Stage 3 — chronological replay (Elo, belt, streaks)
// ---------------------------------------------------------------------------

interface ChampionshipInfo {
  season: number;
  week: number;
  matchupId: number;
  franchiseId: number;
}

/**
 * Refines a matchup's week type using `playoff_tier` — `weeks.week_type` is only ever
 * 'regular'/'playoff' in real data (never literally 'consolation'), but a 'playoff' week's
 * matchups can individually be the real bracket OR a consolation-ladder placement game.
 * Consolation matters for Elo's K-factor and for streak/h2h exclusion, so this distinction has
 * to be made per-matchup, not per-week.
 */
function classifyMatchupWeekType(rawWeekType: ReplayWeekType, playoffTier: string | null): ReplayWeekType {
  if (rawWeekType !== "playoff") return rawWeekType;
  if (playoffTier === "WINNERS_CONSOLATION_LADDER" || playoffTier === "LOSERS_CONSOLATION_LADDER") return "consolation";
  return "playoff";
}

/**
 * Per season: the final 'playoff'-type week's matchup whose winner has `final_standing` 1.
 * Falls back to the highest-scoring `WINNERS_BRACKET` matchup of that week (with a warning) if no
 * winner has `final_standing` 1 recorded. 2015-2017 have NO `playoff_tier` data archived at all
 * (confirmed against real data) — every final-week matchup there still gets checked via
 * `final_standing`, which is what actually makes champion detection work for those seasons too;
 * the `WINNERS_BRACKET` fallback is real defensive-only code, never exercised by real data.
 */
function detectChampionships(
  matchupRows: Matchup[],
  weekByKey: Map<string, Week>,
  teamSeasonById: Map<number, TeamSeason>,
  warnings: string[],
): Map<number, ChampionshipInfo> {
  const bySeasonMatchups = new Map<number, Matchup[]>();
  for (const m of matchupRows) {
    const list = bySeasonMatchups.get(m.season) ?? [];
    list.push(m);
    bySeasonMatchups.set(m.season, list);
  }

  const result = new Map<number, ChampionshipInfo>();

  for (const [season, seasonMatchups] of bySeasonMatchups) {
    const playoffWeeks = seasonMatchups
      .map((m) => weekByKey.get(`${season}:${m.week}`))
      .filter((w): w is Week => !!w && w.weekType === "playoff")
      .map((w) => w.week);
    if (playoffWeeks.length === 0) continue; // no playoff weeks completed yet (e.g. an in-progress season)
    const finalWeek = Math.max(...playoffWeeks);
    const finalWeekMatchups = seasonMatchups.filter((m) => m.week === finalWeek);

    let found: ChampionshipInfo | undefined;
    for (const m of finalWeekMatchups) {
      if (!m.isFinal || m.winner === null || m.winner === "tie") continue;
      const winnerTeamSeasonId = m.winner === "home" ? m.homeTeamSeasonId : m.awayTeamSeasonId;
      const winnerTeamSeason = winnerTeamSeasonId !== null ? teamSeasonById.get(winnerTeamSeasonId) : undefined;
      if (winnerTeamSeason?.finalStanding === 1) {
        found = { season, week: finalWeek, matchupId: m.id, franchiseId: winnerTeamSeason.franchiseId };
        break;
      }
    }

    if (!found) {
      const winnersBracket = finalWeekMatchups.filter(
        (m) => m.playoffTier === "WINNERS_BRACKET" && m.isFinal && m.winner !== null && m.winner !== "tie",
      );
      if (winnersBracket.length > 0) {
        warnings.push(
          `season ${season}: no final-week matchup winner has final_standing=1 — falling back to the highest-scoring WINNERS_BRACKET matchup of week ${finalWeek}`,
        );
        const best = winnersBracket.reduce((a, b) => (Math.max(b.homeScore, b.awayScore) > Math.max(a.homeScore, a.awayScore) ? b : a));
        const winnerTeamSeasonId = best.winner === "home" ? best.homeTeamSeasonId : best.awayTeamSeasonId;
        const winnerTeamSeason = winnerTeamSeasonId !== null ? teamSeasonById.get(winnerTeamSeasonId) : undefined;
        if (winnerTeamSeason) found = { season, week: finalWeek, matchupId: best.id, franchiseId: winnerTeamSeason.franchiseId };
      }
    }

    if (found) {
      result.set(season, found);
    } else {
      warnings.push(
        `season ${season}: could not determine a champion for the final playoff week (${finalWeek}) — belt/records championship data skips this season`,
      );
    }

    const anyTierData = finalWeekMatchups.some((m) => m.playoffTier !== null && m.playoffTier !== "NONE");
    if (!anyTierData && finalWeekMatchups.length > 1) {
      warnings.push(
        `season ${season}: no playoff_tier data archived for the playoff bracket — consolation-bracket games can't be distinguished from the real playoff bracket for this season; all treated as 'playoff'`,
      );
    }
  }

  return result;
}

/** Only completed head-to-head matchups (byes are never events — replay()/h2h() never see them). */
function buildReplayMatchups(
  matchupRows: Matchup[],
  weekByKey: Map<string, Week>,
  teamSeasonById: Map<number, TeamSeason>,
  warnings: string[],
): ReplayMatchupInput[] {
  const out: ReplayMatchupInput[] = [];
  for (const m of matchupRows) {
    if (!m.isFinal || m.winner === null) continue;
    if (m.awayTeamSeasonId === null) continue; // bye

    const homeTeamSeason = teamSeasonById.get(m.homeTeamSeasonId);
    const awayTeamSeason = teamSeasonById.get(m.awayTeamSeasonId);
    if (!homeTeamSeason || !awayTeamSeason) {
      warnings.push(`replay input: matchup ${m.id} references a team_season with no row, skipped`);
      continue;
    }

    const weekMeta = weekByKey.get(`${m.season}:${m.week}`);
    const rawWeekType = (weekMeta?.weekType ?? "regular") as ReplayWeekType;
    const weekType = classifyMatchupWeekType(rawWeekType, m.playoffTier);

    out.push({
      matchupId: m.id,
      season: m.season,
      week: m.week,
      weekType,
      homeFranchiseId: homeTeamSeason.franchiseId,
      awayFranchiseId: awayTeamSeason.franchiseId,
      homeScore: m.homeScore,
      awayScore: m.awayScore,
      winner: m.winner,
    });
  }
  return out;
}

function buildActiveFranchisesBySeason(teamSeasonRows: TeamSeason[]): Record<number, number[]> {
  const bySeason = new Map<number, Set<number>>();
  for (const ts of teamSeasonRows) {
    const set = bySeason.get(ts.season) ?? new Set<number>();
    set.add(ts.franchiseId);
    bySeason.set(ts.season, set);
  }
  const out: Record<number, number[]> = {};
  for (const [season, set] of bySeason) out[season] = [...set];
  return out;
}

/**
 * `app_settings` key `belt_overrides` — JSON array (default []). Documented shape, one entry:
 *   `{ "season": number, "week": number, "franchiseId": number, "reason"?: string }`
 * A commissioner-issued correction to lineal belt history (e.g. fixing a data error), applied at
 * that exact (season, week) position during the chronological replay — see
 * `src/engines/replay.ts`'s `ReplayBeltOverride`. Not a gameplay event.
 */
function readBeltOverrides(db: Db, warnings: string[]): ReplayBeltOverride[] {
  const row = db.select().from(appSettings).where(eq(appSettings.key, "belt_overrides")).get();
  if (!row) return [];

  const raw = row.valueJson;
  if (!Array.isArray(raw)) {
    warnings.push("app_settings.belt_overrides is not a JSON array — ignored");
    return [];
  }

  const out: ReplayBeltOverride[] = [];
  raw.forEach((entry, i) => {
    const e = entry as Record<string, unknown> | null;
    const season = typeof e?.season === "number" ? e.season : undefined;
    const week = typeof e?.week === "number" ? e.week : undefined;
    const franchiseId = typeof e?.franchiseId === "number" ? e.franchiseId : undefined;
    if (season === undefined || week === undefined || franchiseId === undefined) {
      warnings.push(`app_settings.belt_overrides[${i}] missing season/week/franchiseId (numbers), skipped`);
      return;
    }
    out.push({ season, week, franchiseId, reason: typeof e?.reason === "string" ? e.reason : undefined });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Stage 4 — rollups (season/career, record book, H2H)
// ---------------------------------------------------------------------------

function buildSeasonStatsRows(
  buildId: number,
  teamSeasonRows: TeamSeason[],
  allplayWeekRows: NewAllplayWeek[],
  teamWeekRows: NewTeamWeek[],
  championships: Map<number, ChampionshipInfo>,
  beatdownAwards: BeatdownAward[],
): NewSeasonStat[] {
  const allplayByKey = new Map<string, NewAllplayWeek[]>();
  for (const r of allplayWeekRows) {
    const key = `${r.season}:${r.franchiseId}`;
    const list = allplayByKey.get(key) ?? [];
    list.push(r);
    allplayByKey.set(key, list);
  }

  const efficiencyByKey = new Map<string, number[]>();
  for (const tw of teamWeekRows) {
    if (tw.efficiency === null || tw.efficiency === undefined) continue;
    const key = `${tw.season}:${tw.franchiseId}`;
    const list = efficiencyByKey.get(key) ?? [];
    list.push(tw.efficiency);
    efficiencyByKey.set(key, list);
  }

  // Task 17 — count of weekly "Beatdown of the Week" awards taken this season, per franchise.
  const beatdownCountByKey = new Map<string, number>();
  for (const award of beatdownAwards) {
    const key = `${award.season}:${award.franchiseId}`;
    beatdownCountByKey.set(key, (beatdownCountByKey.get(key) ?? 0) + 1);
  }

  // `final_standing > 0` (not a "games played" proxy) gates sacko/champion below. ESPN standings
  // are 1-indexed, so 0 is NEVER a legitimate final_standing — it's ESPN's placeholder, and
  // critically it stays 0 for the ENTIRE season, not just before it starts: a games-played proxy
  // (wins+losses+ties>0) was tried first and is provably insufficient — reproduced against a
  // simulated mid-season 2026 (week 1 played, still final_standing=0 for everyone) that every
  // "played" team tied at the placeholder value (0) and fabricated a sacko for all of them, same
  // as the original pre-season bug. Only a real, completed-season standing (>0) can ever win.
  const maxStandingBySeason = new Map<number, number>();
  for (const ts of teamSeasonRows) {
    if (ts.finalStanding === null || ts.finalStanding <= 0) continue;
    const cur = maxStandingBySeason.get(ts.season);
    if (cur === undefined || ts.finalStanding > cur) maxStandingBySeason.set(ts.season, ts.finalStanding);
  }

  return teamSeasonRows.map((ts) => {
    const key = `${ts.season}:${ts.franchiseId}`;
    const allplayRows = allplayByKey.get(key) ?? [];
    const allplayW = allplayRows.reduce((s, r) => s + r.wins, 0);
    const allplayL = allplayRows.reduce((s, r) => s + r.losses, 0);
    const allplayT = allplayRows.reduce((s, r) => s + r.ties, 0);

    const luckValues = allplayRows.map((r) => r.luckScore).filter((v): v is number => v !== null && v !== undefined);
    const luckTotal = luckValues.length > 0 ? luckValues.reduce((a, b) => a + b, 0) : null;

    // allplay xW = Sum(allplay_wins / (N-1)) across the season's weeks.
    const expectedWins =
      allplayRows.length > 0
        ? allplayRows.reduce((sum, r) => {
            const opponents = r.wins + r.losses + r.ties;
            return sum + (opponents > 0 ? r.wins / opponents : 0);
          }, 0)
        : null;

    const effValues = efficiencyByKey.get(key) ?? [];
    const efficiencyAvg = effValues.length > 0 ? effValues.reduce((a, b) => a + b, 0) / effValues.length : null;

    const hasRealStanding = ts.finalStanding !== null && ts.finalStanding > 0;
    const champ = championships.get(ts.season);
    // `champion` is already implicitly safe (detectChampionships requires a real final_standing
    // of exactly 1 on the winner of a completed final playoff week — impossible while
    // final_standing is still the 0 placeholder), but gated explicitly here too, for the same
    // reason as `sacko`, for defense-in-depth.
    const champion = hasRealStanding && champ?.franchiseId === ts.franchiseId;
    const sacko = hasRealStanding && ts.finalStanding === maxStandingBySeason.get(ts.season);

    return {
      buildId,
      season: ts.season,
      franchiseId: ts.franchiseId,
      wins: ts.wins,
      losses: ts.losses,
      ties: ts.ties,
      pointsFor: ts.pointsFor,
      pointsAgainst: ts.pointsAgainst,
      allplayW,
      allplayL,
      allplayT,
      luckTotal,
      expectedWins,
      efficiencyAvg,
      finalStanding: ts.finalStanding,
      madePlayoffs: ts.madePlayoffs,
      champion,
      sacko,
      beatdowns: beatdownCountByKey.get(`${ts.season}:${ts.franchiseId}`) ?? 0,
    };
  });
}

function buildCareerStatsRows(
  buildId: number,
  seasonStatsRows: NewSeasonStat[],
  franchiseEloRows: NewFranchiseElo[],
  streaks: FranchiseStreakSummary[],
  teamWeekRows: NewTeamWeek[],
  beatdownAwards: BeatdownAward[],
): NewCareerStat[] {
  // RULING (fix round 2): `seasons` count, and every summed total below (wins/losses/points/
  // allplay/luck/xW/efficiency), intentionally count any season with >=1 played game — including
  // an ACTIVE, still-in-progress one. A mid-season 2026 with week 1 done IS the franchise's Nth
  // season, and wins/points already accumulate live; a franchise showing 12 seasons mid-way
  // through its 12th is correct, not corruption. What must NOT come from an incomplete season is
  // `final_standing` itself — see the STRICTER `> 0` filter on `standings` below, kept separate
  // on purpose: ESPN's final_standing stays the 0 placeholder for the entire season (not just
  // before it starts), so Math.min/max over an unfiltered `standings` array would pick up that 0
  // as if it were a real (better-than-any-real-1st-place) finish the instant the season starts.
  const playedSeasonStats = seasonStatsRows.filter((s) => s.wins + s.losses + s.ties > 0);

  const byFranchise = new Map<number, NewSeasonStat[]>();
  for (const s of playedSeasonStats) {
    const list = byFranchise.get(s.franchiseId) ?? [];
    list.push(s);
    byFranchise.set(s.franchiseId, list);
  }

  const eloByFranchise = new Map(franchiseEloRows.map((f) => [f.franchiseId, f]));
  const streakByFranchise = new Map(streaks.map((s) => [s.franchiseId, s]));

  // Highest/lowest single team-week: only real, DECIDED team-weeks (result !== null) — excludes
  // both a bye (no opponent to compare against) and an unplayed/future week (score-so-far of 0,
  // which would otherwise fabricate a franchise's "lowest week ever").
  const playedWeeksByFranchise = new Map<number, NewTeamWeek[]>();
  for (const tw of teamWeekRows) {
    if (tw.result === null) continue;
    const list = playedWeeksByFranchise.get(tw.franchiseId) ?? [];
    list.push(tw);
    playedWeeksByFranchise.set(tw.franchiseId, list);
  }

  // Task 17 — "worst single beatdown": the worst (most negative margin) among THIS franchise's own
  // "Beatdown of the Week" award wins specifically (not merely their personal worst-ever loss —
  // those can differ if someone else had an even worse loss that same week, which would exclude
  // this franchise from that week's award). Paired with the `beatdowns` count below.
  const beatdownAwardsByFranchise = new Map<number, BeatdownAward[]>();
  for (const award of beatdownAwards) {
    const list = beatdownAwardsByFranchise.get(award.franchiseId) ?? [];
    list.push(award);
    beatdownAwardsByFranchise.set(award.franchiseId, list);
  }

  const rows: NewCareerStat[] = [];
  for (const [franchiseId, seasonRowsForFranchise] of byFranchise) {
    const wins = seasonRowsForFranchise.reduce((s, r) => s + r.wins, 0);
    const losses = seasonRowsForFranchise.reduce((s, r) => s + r.losses, 0);
    const ties = seasonRowsForFranchise.reduce((s, r) => s + r.ties, 0);
    const games = wins + losses + ties;
    const winPct = games > 0 ? (wins + 0.5 * ties) / games : 0;

    // `> 0` (not just non-null) — see the ruling-5 comment above `playedSeasonStats`: 0 is ESPN's
    // in-progress-season placeholder, never a real standing, and it persists all season long.
    const standings = seasonRowsForFranchise
      .map((r) => r.finalStanding)
      .filter((v): v is number => v !== null && v !== undefined && v > 0);
    const luckValues = seasonRowsForFranchise.map((r) => r.luckTotal).filter((v): v is number => v !== null && v !== undefined);
    const xwValues = seasonRowsForFranchise.map((r) => r.expectedWins).filter((v): v is number => v !== null && v !== undefined);
    const effValues = seasonRowsForFranchise.map((r) => r.efficiencyAvg).filter((v): v is number => v !== null && v !== undefined);

    const weeksForFranchise = playedWeeksByFranchise.get(franchiseId) ?? [];
    let highest: NewTeamWeek | null = null;
    let lowest: NewTeamWeek | null = null;
    for (const w of weeksForFranchise) {
      if (!highest || w.score > highest.score) highest = w;
      if (!lowest || w.score < lowest.score) lowest = w;
    }

    const elo = eloByFranchise.get(franchiseId);
    const streak = streakByFranchise.get(franchiseId);

    const franchiseBeatdownAwards = beatdownAwardsByFranchise.get(franchiseId) ?? [];
    let worstBeatdown: BeatdownAward | null = null;
    for (const a of franchiseBeatdownAwards) {
      if (!worstBeatdown || a.margin < worstBeatdown.margin) worstBeatdown = a;
    }

    rows.push({
      buildId,
      franchiseId,
      seasons: seasonRowsForFranchise.length,
      wins,
      losses,
      ties,
      winPct,
      pointsFor: seasonRowsForFranchise.reduce((s, r) => s + r.pointsFor, 0),
      pointsAgainst: seasonRowsForFranchise.reduce((s, r) => s + r.pointsAgainst, 0),
      allplayW: seasonRowsForFranchise.reduce((s, r) => s + r.allplayW, 0),
      allplayL: seasonRowsForFranchise.reduce((s, r) => s + r.allplayL, 0),
      allplayT: seasonRowsForFranchise.reduce((s, r) => s + r.allplayT, 0),
      championships: seasonRowsForFranchise.filter((r) => r.champion).length,
      sackos: seasonRowsForFranchise.filter((r) => r.sacko).length,
      playoffAppearances: seasonRowsForFranchise.filter((r) => r.madePlayoffs).length,
      bestFinish: standings.length > 0 ? Math.min(...standings) : null,
      worstFinish: standings.length > 0 ? Math.max(...standings) : null,
      highestWeek: highest ? highest.score : null,
      highestWeekSeason: highest ? highest.season : null,
      highestWeekWeek: highest ? highest.week : null,
      lowestWeek: lowest ? lowest.score : null,
      lowestWeekSeason: lowest ? lowest.season : null,
      lowestWeekWeek: lowest ? lowest.week : null,
      longestWinStreak: streak?.longestWinStreak?.count ?? null,
      longestWinStreakStartSeason: streak?.longestWinStreak?.startSeason ?? null,
      longestWinStreakStartWeek: streak?.longestWinStreak?.startWeek ?? null,
      longestWinStreakEndSeason: streak?.longestWinStreak?.endSeason ?? null,
      longestWinStreakEndWeek: streak?.longestWinStreak?.endWeek ?? null,
      longestLossStreak: streak?.longestLossStreak?.count ?? null,
      longestLossStreakStartSeason: streak?.longestLossStreak?.startSeason ?? null,
      longestLossStreakStartWeek: streak?.longestLossStreak?.startWeek ?? null,
      longestLossStreakEndSeason: streak?.longestLossStreak?.endSeason ?? null,
      longestLossStreakEndWeek: streak?.longestLossStreak?.endWeek ?? null,
      currentElo: elo?.current ?? ELO_START,
      peakElo: elo?.peak ?? ELO_START,
      luckTotal: luckValues.length > 0 ? luckValues.reduce((a, b) => a + b, 0) : null,
      expectedWins: xwValues.length > 0 ? xwValues.reduce((a, b) => a + b, 0) : null,
      efficiencyAvg: effValues.length > 0 ? effValues.reduce((a, b) => a + b, 0) / effValues.length : null,
      beatdowns: seasonRowsForFranchise.reduce((s, r) => s + (r.beatdowns ?? 0), 0),
      worstBeatdownMargin: worstBeatdown ? worstBeatdown.margin : null,
      worstBeatdownSeason: worstBeatdown ? worstBeatdown.season : null,
      worstBeatdownWeek: worstBeatdown ? worstBeatdown.week : null,
    });
  }
  return rows;
}

/**
 * Deliberately uses `team_week.week_type` (Stage 1's COARSE `regular`/`playoff` split) for record
 * ELIGIBILITY — NOT the `playoff_tier`-refined classification `replay()`/`h2h()` use for Elo
 * K-factor/belt-at-stake/streak-and-h2h exclusion. Verified against real data: the league's
 * single highest team-week score ever (187.7, a real `team_week` row) was scored in a game
 * `playoff_tier` tags `LOSERS_CONSOLATION_LADDER` — a placement game, not a title-contention one.
 * Excluding it (the refined classification's literal effect) would have been the more
 * "honest by bracket" choice, but the brief's own real-data expectation for this record
 * (`highest_week_score` rank 1 = 187.7) is unambiguous, so the record book intentionally stays
 * on the coarser, ESPN-native `regular`/`playoff` split for deciding what's eligible.
 *
 * The STORED `week_type` on the resulting entry is a different matter: it's set from the refined
 * classification (`refinedWeekTypeByMatchupId`) so a UI caption for the 187.7 game honestly reads
 * "consolation", not "playoff" — coarse eligibility, refined label (see `RecordsTeamWeekInput.
 * displayWeekType`'s docstring in src/engines/records.ts).
 */
function buildRecordEntryRows(
  buildId: number,
  teamWeekRows: NewTeamWeek[],
  refinedWeekTypeByMatchupId: Map<number, ReplayWeekType>,
  championshipMatchupIds: Set<number>,
  seasonStatsRows: NewSeasonStat[],
  beltReignsOutput: BeltReignOutput[],
  streaks: FranchiseStreakSummary[],
  seasonCompleteBySeason: Map<number, boolean>,
): NewRecordEntry[] {
  const teamWeeksInput: RecordsTeamWeekInput[] = teamWeekRows.map((tw) => {
    const matchupId = typeof tw.matchupId === "number" ? tw.matchupId : null;
    const displayWeekType = matchupId !== null ? refinedWeekTypeByMatchupId.get(matchupId) : undefined;
    return {
      franchiseId: tw.franchiseId,
      season: tw.season,
      week: tw.week,
      weekType: tw.weekType,
      displayWeekType,
      score: tw.score,
      result: tw.result ?? null,
      margin: tw.margin ?? null,
      benchPointsLeft: tw.benchPointsLeft ?? null,
      opponentFranchiseId: tw.opponentFranchiseId ?? null,
      isChampionshipGame: matchupId !== null && championshipMatchupIds.has(matchupId),
    };
  });

  const seasonStatsInput: RecordsSeasonStatInput[] = seasonStatsRows.map((s) => ({
    franchiseId: s.franchiseId,
    season: s.season,
    pointsFor: s.pointsFor,
    pointsAgainst: s.pointsAgainst,
    wins: s.wins,
    losses: s.losses,
    ties: s.ties,
    seasonComplete: seasonCompleteBySeason.get(s.season) ?? false,
  }));

  const beltReignsInput: RecordsBeltReignInput[] = beltReignsOutput.map((r) => ({
    franchiseId: r.franchiseId,
    startSeason: r.startSeason,
    startWeek: r.startWeek,
    weeksHeld: r.weeksHeld,
  }));

  const streaksInput: RecordsStreakInput[] = streaks.map((s) => ({
    franchiseId: s.franchiseId,
    longestWinStreak: s.longestWinStreak,
    longestLossStreak: s.longestLossStreak,
  }));

  const byKey = buildRecordEntries({ teamWeeks: teamWeeksInput, seasonStats: seasonStatsInput, beltReigns: beltReignsInput, streaks: streaksInput });

  const rows: NewRecordEntry[] = [];
  for (const key of RECORD_KEYS) {
    for (const entry of byKey[key]) {
      rows.push({
        buildId,
        recordKey: key,
        rank: entry.rank,
        franchiseId: entry.franchiseId,
        season: entry.season,
        week: entry.week,
        value: entry.value,
        weekType: entry.weekType,
        detailJson: entry.detail ?? null,
      });
    }
  }
  return rows;
}

interface Stage34Rows {
  eloHistoryRows: NewEloHistory[];
  franchiseEloRows: NewFranchiseElo[];
  beltReignRows: NewBeltReign[];
  beltMatchRows: NewBeltMatch[];
  seasonStatsRows: NewSeasonStat[];
  careerStatsRows: NewCareerStat[];
  recordEntryRows: NewRecordEntry[];
  h2hPairRows: NewH2HPair[];
  /** Stage 5 (Task 12) — computed here too since every ingredient it needs (replay's streak/elo/
   * belt output, seasonCompleteBySeason, the refined per-matchup week-type map, h2hInputs) is
   * already in scope at the end of this function; threading all of that back out to a separate
   * top-level "stage 5" function would just be pass-through plumbing for no real benefit. */
  contextNoteRows: NewContextNoteRow[];
}

function computeStage34Rows(
  db: Db,
  buildId: number,
  teamWeekRows: NewTeamWeek[],
  allplayWeekRows: NewAllplayWeek[],
  warnings: string[],
): Stage34Rows {
  const teamSeasonRows = db.select().from(teamSeasons).all();
  const matchupRows = db.select().from(matchups).all();
  const weekRows = db.select().from(weeks).all();
  const seasonRows = db.select().from(seasons).all();

  const teamSeasonById = new Map<number, TeamSeason>(teamSeasonRows.map((t) => [t.id, t]));
  const weekByKey = new Map<string, Week>(weekRows.map((w) => [`${w.season}:${w.week}`, w]));
  const seasonCompleteBySeason = computeSeasonCompleteBySeason(seasonRows, weekRows, matchupRows, warnings);

  const championships = detectChampionships(matchupRows, weekByKey, teamSeasonById, warnings);
  const replayMatchups = buildReplayMatchups(matchupRows, weekByKey, teamSeasonById, warnings);
  const activeFranchisesBySeason = buildActiveFranchisesBySeason(teamSeasonRows);
  const beltOverrides = readBeltOverrides(db, warnings);

  const championsForReplay: ReplayChampion[] = [...championships.values()].map((c) => ({
    season: c.season,
    franchiseId: c.franchiseId,
    week: c.week,
  }));
  const championshipMatchupIds = new Set([...championships.values()].map((c) => c.matchupId));

  const replayResult = replay(replayMatchups, { champions: championsForReplay, activeFranchisesBySeason, beltOverrides });
  warnings.push(...replayResult.warnings);

  const eloHistoryRows: NewEloHistory[] = replayResult.eloHistory.map((e) => ({
    buildId,
    season: e.season,
    week: e.week,
    franchiseId: e.franchiseId,
    eloPre: e.eloPre,
    eloPost: e.eloPost,
  }));
  const franchiseEloRows: NewFranchiseElo[] = replayResult.franchiseElo.map((f) => ({
    buildId,
    franchiseId: f.franchiseId,
    current: f.current,
    peak: f.peak,
    peakSeason: f.peakSeason,
    peakWeek: f.peakWeek,
    trough: f.trough,
    weeksAtNo1: f.weeksAtNo1,
  }));
  const beltReignRows: NewBeltReign[] = replayResult.beltReigns.map((r) => ({
    buildId,
    reignNo: r.reignNo,
    franchiseId: r.franchiseId,
    wonFromFranchiseId: r.wonFromFranchiseId,
    startSeason: r.startSeason,
    startWeek: r.startWeek,
    endSeason: r.endSeason,
    endWeek: r.endWeek,
    defenses: r.defenses,
    weeksHeld: r.weeksHeld,
    endReason: r.endReason,
    isCurrent: r.isCurrent,
  }));
  const beltMatchRows: NewBeltMatch[] = replayResult.beltMatches.map((bm) => ({
    buildId,
    matchupId: bm.matchupId,
    season: bm.season,
    week: bm.week,
    holderFranchiseId: bm.holderFranchiseId,
    challengerFranchiseId: bm.challengerFranchiseId,
    result: bm.result,
    holderScore: bm.holderScore,
    challengerScore: bm.challengerScore,
  }));

  // Task 17 — "Beatdown of the Week": ONE shared derivation (src/engines/records.ts) feeds both
  // season_stats/career_stats counts here AND stage 5's beatdown_of_week context rule (which reads
  // team_week rows + record_entries directly, recomputing the same awards from the same inputs —
  // see buildContextNoteRows below).
  const beatdownAwards = computeWeeklyBeatdowns(
    teamWeekRows.map((tw) => ({ franchiseId: tw.franchiseId, season: tw.season, week: tw.week, result: tw.result ?? null, margin: tw.margin ?? null })),
  );

  const seasonStatsRows = buildSeasonStatsRows(buildId, teamSeasonRows, allplayWeekRows, teamWeekRows, championships, beatdownAwards);
  const careerStatsRows = buildCareerStatsRows(buildId, seasonStatsRows, franchiseEloRows, replayResult.streaks, teamWeekRows, beatdownAwards);

  // replayMatchups already carries the playoff_tier-refined classification per matchup — reused
  // here purely for record_entries' STORED week_type label (see buildRecordEntryRows' docstring),
  // not for eligibility.
  const refinedWeekTypeByMatchupId = new Map(replayMatchups.map((m) => [m.matchupId, m.weekType]));
  const recordEntryRows = buildRecordEntryRows(
    buildId,
    teamWeekRows,
    refinedWeekTypeByMatchupId,
    championshipMatchupIds,
    seasonStatsRows,
    replayResult.beltReigns,
    replayResult.streaks,
    seasonCompleteBySeason,
  );

  const h2hInputs: H2HMatchupInput[] = replayMatchups.map((m) => ({
    matchupId: m.matchupId,
    season: m.season,
    week: m.week,
    weekType: m.weekType,
    homeFranchiseId: m.homeFranchiseId,
    awayFranchiseId: m.awayFranchiseId,
    homeScore: m.homeScore,
    awayScore: m.awayScore,
    winner: m.winner,
  }));
  const h2hPairRows: NewH2HPair[] = buildH2HPairs(h2hInputs).map((p) => ({
    buildId,
    franchiseA: p.franchiseA,
    franchiseB: p.franchiseB,
    regW: p.regularW,
    regL: p.regularL,
    regT: p.regularT,
    playoffW: p.playoffW,
    playoffL: p.playoffL,
    playoffT: p.playoffT,
    pointsA: p.pointsA,
    pointsB: p.pointsB,
    avgMargin: p.avgMargin,
    streakHolder: p.streakHolder,
    streakLen: p.streakLen,
    largestWinJson: p.largestWin,
    closestGameJson: p.closestGame,
    lastMeetingJson: p.lastMeeting,
  }));

  const contextNoteRows = buildContextNoteRows(db, buildId, teamWeekRows, refinedWeekTypeByMatchupId, replayResult, recordEntryRows, h2hInputs, seasonCompleteBySeason);

  return { eloHistoryRows, franchiseEloRows, beltReignRows, beltMatchRows, seasonStatsRows, careerStatsRows, recordEntryRows, h2hPairRows, contextNoteRows };
}

// ---------------------------------------------------------------------------
// Stage 5 — historical context notes (Task 12). See src/engines/context.ts
// for the pure rule engine; this function only gathers and shapes the plain
// data it needs from stage 1-4's already-computed in-memory rows (plus one
// small franchise-name lookup, the only new DB read this stage adds) and
// maps the engine's output back to insertable rows.
// ---------------------------------------------------------------------------

function buildContextNoteRows(
  db: Db,
  buildId: number,
  teamWeekRows: NewTeamWeek[],
  refinedWeekTypeByMatchupId: Map<number, ReplayWeekType>,
  replayResult: ReplayResult,
  recordEntryRows: NewRecordEntry[],
  h2hInputs: H2HMatchupInput[],
  seasonCompleteBySeason: Map<number, boolean>,
): NewContextNoteRow[] {
  const franchiseNameRows = db.select({ id: franchises.id, name: franchises.canonicalName }).from(franchises).all();
  const franchiseNames: Record<number, string> = Object.fromEntries(franchiseNameRows.map((f) => [f.id, f.name]));

  const streakHistoryByKey = new Map(replayResult.streakHistory.map((s) => [`${s.franchiseId}:${s.season}:${s.week}`, s]));
  const eloPostByKey = new Map(replayResult.eloHistory.map((e) => [`${e.franchiseId}:${e.season}:${e.week}`, e.eloPost]));
  const streakSummaryByFranchise = new Map(replayResult.streaks.map((s) => [s.franchiseId, s]));

  // Only DECIDED team-weeks (result !== null) — mirrors every other stage's "never fake it from a
  // bye/unplayed week" rule; the context engine's own tests assume result is always real.
  const teamWeeks: ContextTeamWeekInput[] = teamWeekRows
    .filter((tw): tw is NewTeamWeek & { result: "W" | "L" | "T" } => tw.result !== null && tw.result !== undefined)
    .map((tw) => {
      const key = `${tw.franchiseId}:${tw.season}:${tw.week}`;
      const streakEntry = streakHistoryByKey.get(key);
      const summary = streakSummaryByFranchise.get(tw.franchiseId);
      const refinedWeekType = typeof tw.matchupId === "number" ? (refinedWeekTypeByMatchupId.get(tw.matchupId) ?? tw.weekType) : tw.weekType;
      return {
        franchiseId: tw.franchiseId,
        season: tw.season,
        week: tw.week,
        matchupId: tw.matchupId ?? null,
        score: tw.score,
        result: tw.result,
        weekType: tw.weekType,
        refinedWeekType,
        streakAsOf: streakEntry ? { type: streakEntry.streakType, count: streakEntry.streakCount } : null,
        franchiseLongestWinStreak: summary?.longestWinStreak?.count ?? null,
        franchiseLongestLossStreak: summary?.longestLossStreak?.count ?? null,
        eloPost: eloPostByKey.get(key) ?? null,
        seasonComplete: seasonCompleteBySeason.get(tw.season) ?? false,
        margin: tw.margin ?? null,
      };
    });

  const recordEntriesInput: ContextRecordEntryInput[] = recordEntryRows.map((r) => ({
    recordKey: r.recordKey as (typeof RECORD_KEYS)[number],
    rank: r.rank,
    franchiseId: r.franchiseId,
    season: r.season,
    week: r.week ?? null,
    value: r.value,
  }));

  const h2hMatchups: ContextH2HMatchupInput[] = h2hInputs.map((m) => ({
    matchupId: m.matchupId,
    season: m.season,
    week: m.week,
    weekType: m.weekType,
    homeFranchiseId: m.homeFranchiseId,
    awayFranchiseId: m.awayFranchiseId,
    winner: m.winner,
  }));

  const beltMatchesInput: ContextBeltMatchInput[] = replayResult.beltMatches.map((bm) => ({
    matchupId: bm.matchupId,
    season: bm.season,
    week: bm.week,
    holderFranchiseId: bm.holderFranchiseId,
    challengerFranchiseId: bm.challengerFranchiseId,
    result: bm.result,
  }));

  const beltReignsInput: ContextBeltReignInput[] = replayResult.beltReigns.map((r) => ({
    reignNo: r.reignNo,
    franchiseId: r.franchiseId,
    startSeason: r.startSeason,
    startWeek: r.startWeek,
    defenses: r.defenses,
  }));

  const notes = evaluateContextRules({
    teamWeeks,
    recordEntries: recordEntriesInput,
    h2hMatchups,
    beltMatches: beltMatchesInput,
    beltReigns: beltReignsInput,
    franchiseNames,
  });

  return notes.map((n) => ({
    buildId,
    subjectType: n.subjectType,
    season: n.season,
    week: n.week,
    franchiseId: n.franchiseId,
    matchupId: n.matchupId,
    ruleId: n.ruleId,
    salience: n.salience,
    renderedText: n.renderedText,
    factsJson: n.facts,
  }));
}

// ---------------------------------------------------------------------------
// Stage 6 — achievements (Task 26). See src/engines/achievements.ts for the
// pure rule engine; this function gathers the plain data it needs from
// stage 1 (team_week) and stage 3-4's already-computed in-memory rows
// (belt_matches, elo_history, record_entries), plus one fresh `matchups`
// read of its own to compute the settlement gate (`finalWeeks`) —
// matchupRows isn't otherwise in scope by the time this runs, and re-reading
// it here is the same cheap, already-established pattern
// computeDerivedRows/computeStage34Rows each independently use for their own
// needs (SQLite, local file, ~1031 matchup rows in the real league).
// ---------------------------------------------------------------------------

/**
 * A `"season:week"` key is present only when every `matchups` row for that season/week is
 * final — the achievements engine's SETTLEMENT GATE (see achievements.ts's module docstring).
 * Deliberately simpler than `computeSeasonCompleteBySeason`'s season-scope boundary reasoning
 * (no "genuinely no playoffs configured" inference needed here): a week with zero matchup rows
 * at all (a future week) is correctly excluded by construction — it never gets a Map entry, so
 * it's never added to the output set — and a week with a real mix of final/not-final rows
 * (mid-week) is excluded by the `every()` check. No ambiguity to resolve either way.
 */
function computeFinalWeeks(matchupRows: Matchup[]): Set<string> {
  const byWeek = new Map<string, Matchup[]>();
  for (const m of matchupRows) {
    const key = `${m.season}:${m.week}`;
    const list = byWeek.get(key) ?? [];
    list.push(m);
    byWeek.set(key, list);
  }
  const out = new Set<string>();
  for (const [key, list] of byWeek) {
    if (list.every((m) => m.isFinal)) out.add(key);
  }
  return out;
}

function computeAchievementRows(
  db: Db,
  buildId: number,
  teamWeekRows: NewTeamWeek[],
  beltMatchRows: NewBeltMatch[],
  eloHistoryRows: NewEloHistory[],
  recordEntryRows: NewRecordEntry[],
): NewAchievementRow[] {
  const matchupRows = db.select().from(matchups).all();
  const finalWeeks = computeFinalWeeks(matchupRows);

  const teamWeeksInput: AchievementsTeamWeekInput[] = teamWeekRows.map((tw) => ({
    franchiseId: tw.franchiseId,
    season: tw.season,
    week: tw.week,
    score: tw.score,
    result: tw.result ?? null,
    margin: tw.margin ?? null,
    opponentFranchiseId: tw.opponentFranchiseId ?? null,
    optimalScore: tw.optimalScore ?? null,
    efficiency: tw.efficiency ?? null,
  }));

  const beltMatchesInput: AchievementsBeltMatchInput[] = beltMatchRows.map((bm) => ({
    matchupId: bm.matchupId,
    season: bm.season,
    week: bm.week,
    holderFranchiseId: bm.holderFranchiseId,
    challengerFranchiseId: bm.challengerFranchiseId,
    result: bm.result,
    holderScore: bm.holderScore,
    challengerScore: bm.challengerScore,
  }));

  const eloInput: AchievementsEloInput[] = eloHistoryRows.map((e) => ({
    franchiseId: e.franchiseId,
    season: e.season,
    week: e.week,
    eloPre: e.eloPre,
  }));

  const recordEntriesInput: AchievementsRecordEntryInput[] = recordEntryRows.map((r) => ({
    recordKey: r.recordKey,
    rank: r.rank,
    franchiseId: r.franchiseId,
    season: r.season,
    week: r.week ?? null,
    value: r.value,
  }));

  const awards: AchievementAward[] = computeAchievements({
    teamWeeks: teamWeeksInput,
    beltMatches: beltMatchesInput,
    elo: eloInput,
    recordEntries: recordEntriesInput,
    finalWeeks,
  });

  return awards.map((a) => ({
    buildId,
    achievementKey: a.achievementKey,
    franchiseId: a.franchiseId,
    season: a.season,
    week: a.week,
    dedupeKey: a.dedupeKey,
    payloadJson: a.payload,
  }));
}

// ---------------------------------------------------------------------------
// Stage 7 — slot-level scoring calibration (Task 32). Feeds
// src/engines/winProbability.ts's normal-approximation remaining-starter
// model — see that module's docstring for exactly what this stage can and
// cannot support. A fresh, standalone read of `roster_slots` (no dependency
// on stage 1-6's in-memory rows) — the ONLY source table this stage needs.
// ---------------------------------------------------------------------------

interface SlotSampleAccumulator {
  points: number[];
  seasonMin: number;
  seasonMax: number;
}

function addSample(acc: SlotSampleAccumulator | undefined, points: number, season: number): SlotSampleAccumulator {
  if (!acc) return { points: [points], seasonMin: season, seasonMax: season };
  acc.points.push(points);
  if (season < acc.seasonMin) acc.seasonMin = season;
  if (season > acc.seasonMax) acc.seasonMax = season;
  return acc;
}

function summarizeSlotSample(buildId: number, slot: string, acc: SlotSampleAccumulator): NewSlotScoringStat {
  const n = acc.points.length;
  const mean = acc.points.reduce((sum, p) => sum + p, 0) / n;
  // Sample variance (n-1, the unbiased estimator for a SAMPLE standing in for the population of
  // every hypothetical week this slot could ever produce) — n is in the hundreds per slot for the
  // real league, so n vs n-1 barely moves the number, but n-1 is the statistically correct choice.
  // n=1 defined as variance 0 (a single observation carries no spread information) rather than a
  // division by zero.
  const variance = n > 1 ? acc.points.reduce((sum, p) => sum + (p - mean) ** 2, 0) / (n - 1) : 0;
  return { buildId, slot, mean, variance, sampleSize: n, seasonMin: acc.seasonMin, seasonMax: acc.seasonMax };
}

/**
 * One row per real lineup-slot label seen in `roster_slots` (isStarter=true, points recorded —
 * i.e. a real, played starter, never a bye/bench/still-pending row), PLUS one reserved
 * `CALIBRATION_POOLED_SLOT` ("ALL") row pooling every starter across every slot — the fallback
 * `src/engines/winProbability.ts` uses for a slot missing its own calibrated row (see that
 * module's docstring). Empty array only when `roster_slots` has zero starter rows with recorded
 * points at all (a brand-new, never-synced database) — 2015-2017 alone contribute nothing (no
 * roster_slots rows exist for those seasons at all), but that's invisible here: this function
 * doesn't need to know WHY a season is missing, only that whatever rows genuinely exist get
 * counted, honestly reflecting the true 2018+ boundary without hardcoding it.
 */
function computeSlotScoringStatsRows(db: Db, buildId: number): NewSlotScoringStat[] {
  const rows = db
    .select({ lineupSlot: rosterSlots.lineupSlot, points: rosterSlots.points, season: rosterSlots.season })
    .from(rosterSlots)
    .where(and(eq(rosterSlots.isStarter, true), isNotNull(rosterSlots.points)))
    .all();

  if (rows.length === 0) return [];

  const bySlot = new Map<string, SlotSampleAccumulator>();
  let pooled: SlotSampleAccumulator | undefined;

  for (const r of rows) {
    const points = r.points as number; // isNotNull filtered this at the SQL level
    bySlot.set(r.lineupSlot, addSample(bySlot.get(r.lineupSlot), points, r.season));
    pooled = addSample(pooled, points, r.season);
  }

  const out: NewSlotScoringStat[] = [];
  for (const [slot, acc] of bySlot) out.push(summarizeSlotSample(buildId, slot, acc));
  if (pooled) out.push(summarizeSlotSample(buildId, CALIBRATION_POOLED_SLOT, pooled));
  return out;
}
