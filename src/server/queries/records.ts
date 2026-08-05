import { eq } from "drizzle-orm";
import { RECORD_KEYS, type RecordKey } from "@/engines";
// `formatPct` is a pure, framework-free string formatter (no React/DOM) — reused here rather than
// duplicated. It stays defined in components/history/format.ts (not moved under src/server/)
// because client components (e.g. H2HStripTable) import the REST of that module directly, and
// src/server/* is off-limits to client components per AGENTS.md; a query module importing one
// pure formatter the other direction doesn't create that problem. A dedicated layer-neutral
// module (e.g. src/lib/) would be the longer-term-cleaner home if this set of shared pure
// formatters grows, but isn't warranted for a single reused function yet.
import { formatPct } from "@/components/history/format";
import { getDb } from "../db/client";
import { franchises, recordEntries } from "../db/schema";

export type RecordGroupKey = "single-week" | "season" | "streaks" | "belt" | "championship";

type Formatter = (value: number) => string;

const formatPoints: Formatter = (v) => `${v.toFixed(1)} pts`;
const formatGames: Formatter = (v) => `${Math.round(v)} game${Math.round(v) === 1 ? "" : "s"}`;
const formatWeeks: Formatter = (v) => `${Math.round(v)} week${Math.round(v) === 1 ? "" : "s"}`;

interface RecordKeyMeta {
  label: string;
  group: RecordGroupKey;
  format: Formatter;
}

/** Display metadata for every RECORD_KEYS entry — label, section grouping, value formatter. */
export const RECORD_KEY_META: Record<RecordKey, RecordKeyMeta> = {
  highest_week_score: { label: "Highest Week Score", group: "single-week", format: formatPoints },
  lowest_week_score: { label: "Lowest Week Score", group: "single-week", format: formatPoints },
  largest_blowout: { label: "Largest Blowout (margin)", group: "single-week", format: formatPoints },
  closest_game: { label: "Closest Win (margin)", group: "single-week", format: formatPoints },
  most_points_in_loss: { label: "Most Points in a Loss", group: "single-week", format: formatPoints },
  fewest_points_in_win: { label: "Fewest Points in a Win", group: "single-week", format: formatPoints },
  highest_bench_points_left: { label: "Most Points Left on Bench", group: "single-week", format: formatPoints },
  highest_season_total: { label: "Highest Season Total", group: "season", format: formatPoints },
  lowest_season_total: { label: "Lowest Season Total", group: "season", format: formatPoints },
  best_season_record: { label: "Best Season Win%", group: "season", format: formatPct },
  worst_season_record: { label: "Worst Season Win%", group: "season", format: formatPct },
  most_season_points_against: { label: "Most Points Against, Season", group: "season", format: formatPoints },
  longest_win_streak: { label: "Longest Win Streak", group: "streaks", format: formatGames },
  longest_loss_streak: { label: "Longest Loss Streak", group: "streaks", format: formatGames },
  longest_belt_reign: { label: "Longest Belt Reign", group: "belt", format: formatWeeks },
  highest_championship_score: { label: "Highest Championship Score", group: "championship", format: formatPoints },
  // Task 17 — shame side of "Largest Blowout (margin)", loser-attributed. Same group
  // ("single-week") and formatter (signed margin, e.g. "-38.4 pts") — never gold (that's reserved
  // for belt/championship groups only), same as every other single-week record.
  worst_beatdown: { label: "Worst Beatdown (margin)", group: "single-week", format: formatPoints },
};

export const RECORD_GROUPS: { key: RecordGroupKey; label: string }[] = [
  { key: "single-week", label: "Single-Week" },
  { key: "season", label: "Season" },
  { key: "streaks", label: "Streaks" },
  { key: "belt", label: "Belt" },
  { key: "championship", label: "Championship" },
];

export interface RecordRow {
  recordKey: RecordKey;
  rank: number;
  franchiseId: number;
  franchiseName: string;
  value: number;
  season: number;
  week: number | null;
  weekType: string | null;
}

export interface RecordSection {
  key: RecordKey;
  label: string;
  format: Formatter;
  rows: RecordRow[];
}

export interface RecordGroupSection {
  group: RecordGroupKey;
  groupLabel: string;
  sections: RecordSection[];
}

/**
 * Groups a flat list of resolved record_entries rows into the 5 UI sections
 * (single-week/season/streaks/belt/championship), each holding its
 * RECORD_KEYS in declared order, rows sorted by rank. Pure — unit-tested
 * directly against fixture rows, no DB.
 */
export function groupRecordSections(rows: RecordRow[]): RecordGroupSection[] {
  const byKey = new Map<RecordKey, RecordRow[]>();
  for (const r of rows) {
    const list = byKey.get(r.recordKey) ?? [];
    list.push(r);
    byKey.set(r.recordKey, list);
  }

  return RECORD_GROUPS.map((g) => ({
    group: g.key,
    groupLabel: g.label,
    sections: RECORD_KEYS.filter((k) => RECORD_KEY_META[k].group === g.key).map((k) => ({
      key: k,
      label: RECORD_KEY_META[k].label,
      format: RECORD_KEY_META[k].format,
      rows: (byKey.get(k) ?? []).slice().sort((a, b) => a.rank - b.rank),
    })),
  }));
}

export function getRecordBook(): RecordGroupSection[] {
  const db = getDb();
  const rows = db
    .select({
      recordKey: recordEntries.recordKey,
      rank: recordEntries.rank,
      franchiseId: recordEntries.franchiseId,
      franchiseName: franchises.canonicalName,
      value: recordEntries.value,
      season: recordEntries.season,
      week: recordEntries.week,
      weekType: recordEntries.weekType,
    })
    .from(recordEntries)
    .innerJoin(franchises, eq(recordEntries.franchiseId, franchises.id))
    .all();

  return groupRecordSections(rows as RecordRow[]);
}
