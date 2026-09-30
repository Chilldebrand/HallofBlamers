import type { RecordKey } from "../engines";
import { formatPct } from "../components/history/format";
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


