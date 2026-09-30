export interface EloPoint {
  x: number;
  season: number;
  week: number;
  elo: number;
  /** True only on the LAST point of a season this franchise won the championship — the profile
   * Elo chart's gold dot (README, Franchise "Elo history": "6px gold dots on championship
   * seasons"). Always false from `buildEloSeries` itself; set by `markSeasonEndDots`. */
  isChampionSeason: boolean;
  /** Same idea, tarnish dot, sacko seasons. */
  isSackoSeason: boolean;
}

export interface EloSeasonTick {
  x: number;
  season: number;
}

export interface EloSeries {
  points: EloPoint[];
  seasonTicks: EloSeasonTick[];
}

/**
 * x = sequential index into THIS franchise's own elo_history rows (bye weeks
 * produce no row, so the line is continuous across the franchise's actual
 * games, not the league's raw week numbers). Season boundary ticks mark
 * every index where the season changes. Downsamples defensively past
 * `maxPoints`, though real per-franchise history never gets close (~150 pts
 * for an 11-season franchise vs. the 800 ceiling).
 */
export function buildEloSeries(rows: { season: number; week: number; eloPost: number }[], maxPoints = 800): EloSeries {
  const sorted = [...rows].sort((a, b) => a.season - b.season || a.week - b.week);
  let sampled = sorted;
  if (sorted.length > maxPoints) {
    const step = Math.ceil(sorted.length / maxPoints);
    sampled = sorted.filter((_, i) => i % step === 0 || i === sorted.length - 1);
  }

  const points: EloPoint[] = sampled.map((r, i) => ({ x: i, season: r.season, week: r.week, elo: r.eloPost, isChampionSeason: false, isSackoSeason: false }));

  const seasonTicks: EloSeasonTick[] = [];
  let lastSeason: number | null = null;
  for (const p of points) {
    if (p.season !== lastSeason) {
      seasonTicks.push({ x: p.x, season: p.season });
      lastSeason = p.season;
    }
  }

  return { points, seasonTicks };
}

/**
 * Marks the LAST point of every season in `championSeasons`/`sackoSeasons` — the point the
 * profile Elo chart draws its championship/sacko dot on (a season's Elo-at-close, not its peak
 * within the season). Pure — unit-tested directly. Does not mutate its input.
 */
export function markSeasonEndDots(points: EloPoint[], championSeasons: Set<number>, sackoSeasons: Set<number>): EloPoint[] {
  const lastIndexBySeason = new Map<number, number>();
  points.forEach((p, i) => lastIndexBySeason.set(p.season, i));

  const result = points.map((p) => ({ ...p }));
  for (const [season, idx] of lastIndexBySeason) {
    if (championSeasons.has(season)) result[idx]!.isChampionSeason = true;
    if (sackoSeasons.has(season)) result[idx]!.isSackoSeason = true;
  }
  return result;
}

/** The highest-Elo point across a series — ties keep the FIRST occurrence. Pure, null for an
 * empty series. Drives the Elo History section heading's "peak 1651 in 2025 Wk 16" summary. */
export function findEloPeak(points: EloPoint[]): EloPoint | null {
  if (points.length === 0) return null;
  return points.reduce((best, p) => (p.elo > best.elo ? p : best), points[0]!);
}


