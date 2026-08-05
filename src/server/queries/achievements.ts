/**
 * Query layer for the `achievements` table (stat-build stage 6, `src/engines/achievements.ts`) —
 * the FIRST UI consumer (Task 33 wiring wave). 1,127 real rows exist by the time this ships. Reads
 * only — never re-derives an award; "what this shows" and "what `build.ts` computed" can never
 * drift apart, same discipline every other derived-stats query file in this directory follows.
 */
import { and, eq } from "drizzle-orm";
import type { AchievementKey } from "@/engines";
import { getDb } from "../db/client";
import { achievements, franchises } from "../db/schema";

export interface AchievementMeta {
  label: string;
  description: string;
}

/**
 * Plain-with-a-little-edge copy, per league convention — see other RECORD_KEY_META-style maps
 * in this directory (e.g. records.ts) for the same "label + one honest line" shape. Every
 * description here must match what `src/engines/achievements.ts` actually awards, not a vibe —
 * fix round 1, finding 5 corrected two that overstated their real criterion:
 *   - `bench_disaster` (`evalPerfectLineupAndBenchDisaster`): fires when the team LOST and its
 *     OPTIMAL lineup (best legal combination from its actual roster) would have out-scored the
 *     opponent — not "the bench alone," which describes a different (and unimplemented) check.
 *   - `record_breaker` (`evalRecordBreaker`): fires for every `record_entries` row at `rank === 1`
 *     with `week !== null` — i.e. a genuine new all-time #1 in a WEEK-SCOPE record. It does not
 *     distinguish "sets" from "ties" the way `emit-events.ts`'s `RecordBroken` live event does,
 *     and never fires for season/career/streak-scope records (`week === null`) — "set, tied, or
 *     broke an all-time league record" overstated both the scope and the sets-vs-ties distinction.
 */
export const ACHIEVEMENT_KEY_META: Record<AchievementKey, AchievementMeta> = {
  perfect_lineup: { label: "Perfect Lineup", description: "Started the exact optimal lineup that week." },
  bench_disaster: { label: "Bench Disaster", description: "Lost a game the optimal lineup would have won." },
  weekly_high: { label: "Weekly High", description: "Top score of the week." },
  narrow_escape: { label: "Narrow Escape", description: "Won by less than 2 points." },
  heartbreaker: { label: "Heartbreaker", description: "Lost by less than 2 points." },
  belt_thief: { label: "Belt Thief", description: "Took the belt off the reigning holder." },
  belt_defender: { label: "Belt Defender", description: "Defended the belt." },
  giant_killer: { label: "Giant Killer", description: "Beat an opponent with a much higher Elo rating." },
  record_breaker: { label: "Record Breaker", description: "Set a new all-time single-week record." },
  lucky_winner: { label: "Lucky Winner", description: "Won despite scoring below the week's median." },
};

/** Unrecognized keys (a future achievement type this build of the UI doesn't know about yet) are
 * simply skipped by every function below — never rendered with a fabricated label. */
function metaFor(key: string): AchievementMeta | null {
  return Object.prototype.hasOwnProperty.call(ACHIEVEMENT_KEY_META, key) ? ACHIEVEMENT_KEY_META[key as AchievementKey] : null;
}

// ---------------------------------------------------------------------------
// Franchise profile trophy case
// ---------------------------------------------------------------------------

export interface FranchiseAchievementGroup {
  achievementKey: AchievementKey;
  label: string;
  description: string;
  count: number;
  mostRecent: { season: number; week: number };
}

/** Every achievement type this franchise has earned at least once, grouped with a career count +
 * the most recent occurrence — the franchise profile's trophy case grid. Most-earned first, ties
 * broken alphabetically by label for a stable render order. */
export function getFranchiseAchievements(franchiseId: number): FranchiseAchievementGroup[] {
  const db = getDb();
  const rows = db
    .select({ achievementKey: achievements.achievementKey, season: achievements.season, week: achievements.week })
    .from(achievements)
    .where(eq(achievements.franchiseId, franchiseId))
    .all();

  const byKey = new Map<string, { season: number; week: number }[]>();
  for (const r of rows) {
    const list = byKey.get(r.achievementKey) ?? [];
    list.push({ season: r.season, week: r.week });
    byKey.set(r.achievementKey, list);
  }

  const out: FranchiseAchievementGroup[] = [];
  for (const [key, occurrences] of byKey) {
    const meta = metaFor(key);
    if (!meta) continue;
    const mostRecent = [...occurrences].sort((a, b) => b.season - a.season || b.week - a.week)[0]!;
    out.push({ achievementKey: key as AchievementKey, label: meta.label, description: meta.description, count: occurrences.length, mostRecent });
  }

  return out.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// Week hub strip
// ---------------------------------------------------------------------------

export interface WeekAchievementRow {
  achievementKey: AchievementKey;
  label: string;
  franchiseId: number;
  franchiseName: string;
}

/** Every achievement awarded for a specific (season, week) — the week hub's compact strip. Empty
 * for any week the achievements engine's own SETTLEMENT GATE hasn't cleared yet (see
 * src/engines/achievements.ts's docstring) — this query never tries to distinguish "not settled"
 * from "settled with zero awards" itself, same "reads what was already recorded, never re-derives"
 * discipline as the lineup-holes query. */
export function getWeekAchievements(season: number, week: number): WeekAchievementRow[] {
  const db = getDb();
  const rows = db
    .select({ achievementKey: achievements.achievementKey, franchiseId: achievements.franchiseId })
    .from(achievements)
    .where(and(eq(achievements.season, season), eq(achievements.week, week)))
    .all();
  if (rows.length === 0) return [];

  const franchiseRows = db.select({ id: franchises.id, name: franchises.canonicalName }).from(franchises).all();
  const nameById = new Map(franchiseRows.map((f) => [f.id, f.name]));

  return rows
    .map((r) => {
      const meta = metaFor(r.achievementKey);
      if (!meta) return null;
      return { achievementKey: r.achievementKey as AchievementKey, label: meta.label, franchiseId: r.franchiseId, franchiseName: nameById.get(r.franchiseId) ?? `Franchise ${r.franchiseId}` };
    })
    .filter((r): r is WeekAchievementRow => r !== null)
    .sort((a, b) => a.label.localeCompare(b.label) || a.franchiseName.localeCompare(b.franchiseName));
}
