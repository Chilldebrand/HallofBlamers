import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { appSettings, careerStats, contextNotes, franchises, matchups, recordEntries, seasonStats } from "../db/schema";
import { computeMostRecentCompletedWeek, type WeekSignal } from "./matchups";

export interface ChampionInfo {
  franchiseId: number;
  franchiseName: string;
  wins: number;
  losses: number;
  pointsFor: number;
}

/** The season's champion (season_stats.champion), joined to the franchise. */
export function getChampion(season: number): ChampionInfo | null {
  const db = getDb();
  const row = db
    .select({
      franchiseId: franchises.id,
      franchiseName: franchises.canonicalName,
      wins: seasonStats.wins,
      losses: seasonStats.losses,
      pointsFor: seasonStats.pointsFor,
    })
    .from(seasonStats)
    .innerJoin(franchises, eq(seasonStats.franchiseId, franchises.id))
    .where(and(eq(seasonStats.season, season), eq(seasonStats.champion, true)))
    .get();

  return row ?? null;
}

export interface RecordTeaser {
  franchiseName: string;
  season: number;
  week: number | null;
  value: number;
}

/** The #1 all-time entry for a given record_entries.record_key. */
export function getTopRecord(recordKey: string): RecordTeaser | null {
  const db = getDb();
  const row = db
    .select({
      franchiseName: franchises.canonicalName,
      season: recordEntries.season,
      week: recordEntries.week,
      value: recordEntries.value,
    })
    .from(recordEntries)
    .innerJoin(franchises, eq(recordEntries.franchiseId, franchises.id))
    .where(and(eq(recordEntries.recordKey, recordKey), eq(recordEntries.rank, 1)))
    .get();

  return row ?? null;
}

// ---------------------------------------------------------------------------
// Draft countdown
// ---------------------------------------------------------------------------

export const DEFAULT_DRAFT_DATE = "2026-08-29";

export interface DraftCountdown {
  targetDateIso: string;
  daysRemaining: number;
}

/**
 * Whole-day countdown to `targetIso` (a "YYYY-MM-DD" date, interpreted as UTC
 * midnight), measured from `now`'s own UTC calendar date — so a same-day
 * draft reads 0, not a fractional/negative value from time-of-day noise.
 * Pure — unit-tested directly.
 */
export function computeDaysRemaining(targetIso: string, now: Date): number {
  const target = new Date(`${targetIso}T00:00:00Z`);
  const nowUtcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const diffMs = target.getTime() - nowUtcMidnight.getTime();
  return Math.round(diffMs / 86_400_000);
}

/** `app_settings` key `draft_date` (a JSON string "YYYY-MM-DD"), default DEFAULT_DRAFT_DATE. */
export function getDraftCountdown(now: Date = new Date()): DraftCountdown {
  const db = getDb();
  const row = db.select().from(appSettings).where(eq(appSettings.key, "draft_date")).get();
  const targetDateIso = typeof row?.valueJson === "string" ? row.valueJson : DEFAULT_DRAFT_DATE;
  return { targetDateIso, daysRemaining: computeDaysRemaining(targetDateIso, now) };
}

// ---------------------------------------------------------------------------
// Elo top 5
// ---------------------------------------------------------------------------

export interface EloTopRow {
  franchiseId: number;
  name: string;
  elo: number;
}

export function getEloTop(limit = 5): EloTopRow[] {
  const db = getDb();
  return db
    .select({ franchiseId: careerStats.franchiseId, name: franchises.canonicalName, elo: careerStats.currentElo })
    .from(careerStats)
    .innerJoin(franchises, eq(careerStats.franchiseId, franchises.id))
    .orderBy(desc(careerStats.currentElo))
    .limit(limit)
    .all();
}

// ---------------------------------------------------------------------------
// "Last time out" — top 3 context notes of the most recent COMPLETED week.
// Deliberately NOT "this week in league history" (a different, later feature) — see
// src/engines/context.ts and Task 12's brief.
// ---------------------------------------------------------------------------

export interface LastTimeOutNote {
  ruleId: string;
  renderedText: string;
  /** Additive (Task 22): lets callers resolve identity flags (FranchiseName) for this note's
   * subject — null for a matchup-scoped note (e.g. belt_stakes) with no single franchise. */
  franchiseId: number | null;
  franchiseName: string | null;
  /** True only for a belt_stakes note — the ONE case this strip renders gold. */
  isBeltNote: boolean;
}

export interface LastTimeOut {
  season: number;
  week: number;
  notes: LastTimeOutNote[];
}

/** Null when no week has ever been completed, OR the most recent completed week has no context
 * notes at all — the caller skips the "Last time out" section entirely in either case. */
export function getLastTimeOut(): LastTimeOut | null {
  const db = getDb();
  const matchupRows = db.select({ season: matchups.season, week: matchups.week, isFinal: matchups.isFinal }).from(matchups).all();
  const byKey = new Map<string, WeekSignal>();
  for (const r of matchupRows) {
    const key = `${r.season}:${r.week}`;
    const existing = byKey.get(key);
    if (existing) existing.hasFinal = existing.hasFinal || r.isFinal;
    else byKey.set(key, { season: r.season, week: r.week, hasFinal: r.isFinal });
  }
  const target = computeMostRecentCompletedWeek([...byKey.values()]);
  if (!target) return null;

  // Full (salience, rule_id, id) tiebreak — see the identical note on getMatchupDetail in
  // matchups.ts: combining notes across multiple different subjects can genuinely tie on
  // salience, and SQLite's own tie order otherwise isn't guaranteed stable across page loads.
  const noteRows = db
    .select({
      ruleId: contextNotes.ruleId,
      renderedText: contextNotes.renderedText,
      franchiseId: contextNotes.franchiseId,
    })
    .from(contextNotes)
    .where(and(eq(contextNotes.season, target.season), eq(contextNotes.week, target.week)))
    .orderBy(desc(contextNotes.salience), asc(contextNotes.ruleId), asc(contextNotes.id))
    .limit(3)
    .all();
  if (noteRows.length === 0) return null;

  const franchiseRows = db.select({ id: franchises.id, name: franchises.canonicalName }).from(franchises).all();
  const nameById = new Map(franchiseRows.map((f) => [f.id, f.name]));

  return {
    season: target.season,
    week: target.week,
    notes: noteRows.map((r) => ({
      ruleId: r.ruleId,
      renderedText: r.renderedText,
      franchiseId: r.franchiseId,
      franchiseName: r.franchiseId !== null ? (nameById.get(r.franchiseId) ?? "—") : null,
      isBeltNote: r.ruleId === "belt_stakes",
    })),
  };
}
