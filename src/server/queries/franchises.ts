import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { ELO_START, type RecordKey } from "@/engines";
import { getDb } from "../db/client";
import {
  careerStats,
  eloHistory,
  franchiseManagers,
  franchises,
  h2hPairs,
  recordEntries,
  seasonStats,
  teamSeasons,
  beltReigns,
} from "../db/schema";
import { flipH2HPair, type H2HPerspectiveRow } from "./h2h";

// ---------------------------------------------------------------------------
// /franchises index
// ---------------------------------------------------------------------------

export interface FranchiseIndexRow {
  id: number;
  name: string;
  manager: string;
  active: boolean;
  wins: number;
  losses: number;
  ties: number;
  winPct: number;
  championships: number;
  currentElo: number;
  beltReignCount: number;
}

/** Active first (by current Elo desc), then departed (also Elo desc). Pure — unit-tested directly. */
export function sortFranchiseIndex(rows: FranchiseIndexRow[]): FranchiseIndexRow[] {
  return [...rows].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return b.currentElo - a.currentElo;
  });
}

export function getFranchiseIndex(): FranchiseIndexRow[] {
  const db = getDb();
  const franchiseRows = db.select().from(franchises).all();
  const careerRows = db.select().from(careerStats).all();
  const careerByFranchise = new Map(careerRows.map((c) => [c.franchiseId, c]));
  const beltCounts = db
    .select({ franchiseId: beltReigns.franchiseId, count: sql<number>`count(*)` })
    .from(beltReigns)
    .groupBy(beltReigns.franchiseId)
    .all();
  const beltCountByFranchise = new Map(beltCounts.map((b) => [b.franchiseId, Number(b.count)]));

  const rows: FranchiseIndexRow[] = franchiseRows.map((f) => {
    const career = careerByFranchise.get(f.id);
    return {
      id: f.id,
      name: f.canonicalName,
      manager: f.managerName,
      active: f.active,
      wins: career?.wins ?? 0,
      losses: career?.losses ?? 0,
      ties: career?.ties ?? 0,
      winPct: career?.winPct ?? 0,
      championships: career?.championships ?? 0,
      currentElo: career?.currentElo ?? ELO_START,
      beltReignCount: beltCountByFranchise.get(f.id) ?? 0,
    };
  });

  return sortFranchiseIndex(rows);
}

// ---------------------------------------------------------------------------
// /franchises/[id] — header
// ---------------------------------------------------------------------------

export interface FranchiseManagerTenure {
  name: string;
  fromSeason: number;
  toSeason: number | null;
}

export interface FranchiseHeader {
  id: number;
  name: string;
  active: boolean;
  joinedSeason: number;
  departedSeason: number | null;
  managers: FranchiseManagerTenure[];
  wins: number;
  losses: number;
  ties: number;
  winPct: number;
  pointsFor: number;
  pointsAgainst: number;
  championships: number;
  sackos: number;
  currentElo: number;
  peakElo: number;
  beltReignCount: number;
  /** Task 17 — career "Beatdown of the Week" award count. */
  beatdowns: number;
  /** career_stats.seasons — the authoritative season count (used by the profile header's
   * "joined 2018 · 8 seasons" line and the never-held-belt empty state). */
  seasons: number;
}

export function getFranchiseHeader(id: number): FranchiseHeader | null {
  const db = getDb();
  const franchise = db.select().from(franchises).where(eq(franchises.id, id)).get();
  if (!franchise) return null;

  const career = db.select().from(careerStats).where(eq(careerStats.franchiseId, id)).get();
  const managers = db
    .select({ name: franchiseManagers.managerName, fromSeason: franchiseManagers.fromSeason, toSeason: franchiseManagers.toSeason })
    .from(franchiseManagers)
    .where(eq(franchiseManagers.franchiseId, id))
    .orderBy(asc(franchiseManagers.fromSeason))
    .all();
  const beltCount = db.select({ count: sql<number>`count(*)` }).from(beltReigns).where(eq(beltReigns.franchiseId, id)).get();

  return {
    id: franchise.id,
    name: franchise.canonicalName,
    active: franchise.active,
    joinedSeason: franchise.joinedSeason,
    departedSeason: franchise.departedSeason,
    managers,
    wins: career?.wins ?? 0,
    losses: career?.losses ?? 0,
    ties: career?.ties ?? 0,
    winPct: career?.winPct ?? 0,
    pointsFor: career?.pointsFor ?? 0,
    pointsAgainst: career?.pointsAgainst ?? 0,
    championships: career?.championships ?? 0,
    sackos: career?.sackos ?? 0,
    currentElo: career?.currentElo ?? ELO_START,
    peakElo: career?.peakElo ?? ELO_START,
    beltReignCount: Number(beltCount?.count ?? 0),
    beatdowns: career?.beatdowns ?? 0,
    seasons: career?.seasons ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Belt-uniqueness for the "never held the belt" empty state (Franchise.dc.html
// 9b: "the only active franchise with none" — a real comparative claim, not
// designer flourish, so it must be computed against the OTHER active
// franchises' real belt_reigns counts rather than assumed true.)
// ---------------------------------------------------------------------------

/** How many active franchises (from the /franchises index shape) have never held the belt.
 * Pure — unit-tested directly. */
export function countActiveFranchisesWithoutBelt(rows: { active: boolean; beltReignCount: number }[]): number {
  return rows.filter((r) => r.active && r.beltReignCount === 0).length;
}

// ---------------------------------------------------------------------------
// Elo history chart data
// ---------------------------------------------------------------------------

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

export function getFranchiseEloSeries(id: number): EloSeries {
  const db = getDb();
  const rows = db
    .select({ season: eloHistory.season, week: eloHistory.week, eloPost: eloHistory.eloPost })
    .from(eloHistory)
    .where(eq(eloHistory.franchiseId, id))
    .all();
  const series = buildEloSeries(rows);

  const statRows = db
    .select({ season: seasonStats.season, champion: seasonStats.champion, sacko: seasonStats.sacko })
    .from(seasonStats)
    .where(eq(seasonStats.franchiseId, id))
    .all();
  const championSeasons = new Set(statRows.filter((r) => r.champion).map((r) => r.season));
  const sackoSeasons = new Set(statRows.filter((r) => r.sacko).map((r) => r.season));

  return { points: markSeasonEndDots(series.points, championSeasons, sackoSeasons), seasonTicks: series.seasonTicks };
}

// ---------------------------------------------------------------------------
// Season-by-season table
// ---------------------------------------------------------------------------

export interface FranchiseSeasonRow {
  season: number;
  teamName: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  allplayW: number;
  allplayL: number;
  allplayT: number;
  luckTotal: number | null;
  efficiencyAvg: number | null;
  finalStanding: number | null;
  champion: boolean;
  sacko: boolean;
  madePlayoffs: boolean;
}

/** Newest season first — matches how a PFR-style franchise page reads. */
export function getFranchiseSeasons(id: number): FranchiseSeasonRow[] {
  const db = getDb();
  const teamSeasonRows = db.select().from(teamSeasons).where(eq(teamSeasons.franchiseId, id)).all();
  const statsRows = db.select().from(seasonStats).where(eq(seasonStats.franchiseId, id)).all();
  const statsBySeason = new Map(statsRows.map((s) => [s.season, s]));

  return teamSeasonRows
    .map((ts) => {
      const stats = statsBySeason.get(ts.season);
      return {
        season: ts.season,
        teamName: ts.teamName,
        wins: ts.wins,
        losses: ts.losses,
        ties: ts.ties,
        pointsFor: ts.pointsFor,
        pointsAgainst: ts.pointsAgainst,
        allplayW: stats?.allplayW ?? 0,
        allplayL: stats?.allplayL ?? 0,
        allplayT: stats?.allplayT ?? 0,
        luckTotal: stats?.luckTotal ?? null,
        efficiencyAvg: stats?.efficiencyAvg ?? null,
        finalStanding: ts.finalStanding,
        champion: stats?.champion ?? false,
        sacko: stats?.sacko ?? false,
        madePlayoffs: ts.madePlayoffs,
      };
    })
    .sort((a, b) => b.season - a.season);
}

// ---------------------------------------------------------------------------
// Belt history slice
// ---------------------------------------------------------------------------

export interface FranchiseBeltRow {
  reignNo: number;
  startSeason: number;
  startWeek: number;
  endSeason: number | null;
  endWeek: number | null;
  defenses: number;
  weeksHeld: number;
  endReason: "lost" | "vacated" | "override" | null;
  isCurrent: boolean;
  wonFromName: string | null;
  /** Fix round 1, finding 5 — the profile page's "Won From" link needs the actual franchise id,
   * not just a display name, to link to that franchise's own page instead of the static index. */
  wonFromFranchiseId: number | null;
}

export function getFranchiseBeltHistory(id: number): FranchiseBeltRow[] {
  const db = getDb();
  const reigns = db.select().from(beltReigns).where(eq(beltReigns.franchiseId, id)).orderBy(asc(beltReigns.reignNo)).all();
  const franchiseRows = db.select({ id: franchises.id, name: franchises.canonicalName }).from(franchises).all();
  const nameById = new Map(franchiseRows.map((f) => [f.id, f.name]));

  return reigns.map((r) => ({
    reignNo: r.reignNo,
    startSeason: r.startSeason,
    startWeek: r.startWeek,
    endSeason: r.endSeason,
    endWeek: r.endWeek,
    defenses: r.defenses,
    weeksHeld: r.weeksHeld,
    endReason: r.endReason,
    isCurrent: r.isCurrent,
    wonFromName: r.wonFromFranchiseId !== null ? (nameById.get(r.wonFromFranchiseId) ?? null) : null,
    wonFromFranchiseId: r.wonFromFranchiseId,
  }));
}

// ---------------------------------------------------------------------------
// H2H strip
// ---------------------------------------------------------------------------

/** Every opponent this franchise has a history against, sorted games desc by default. */
export function getFranchiseH2H(id: number): H2HPerspectiveRow[] {
  const db = getDb();
  const pairs = db
    .select()
    .from(h2hPairs)
    .where(or(eq(h2hPairs.franchiseA, id), eq(h2hPairs.franchiseB, id)))
    .all();
  const franchiseRows = db.select({ id: franchises.id, name: franchises.canonicalName }).from(franchises).all();
  const nameById = new Map(franchiseRows.map((f) => [f.id, f.name]));
  const nameOf = (fid: number) => nameById.get(fid) ?? `Franchise ${fid}`;

  return pairs.map((p) => flipH2HPair(p, id, nameOf)).sort((a, b) => b.games - a.games);
}

// ---------------------------------------------------------------------------
// Record book entries held
// ---------------------------------------------------------------------------

export interface FranchiseRecordRow {
  recordKey: RecordKey;
  rank: number;
  value: number;
  season: number;
  week: number | null;
  weekType: string | null;
}

export function getFranchiseRecords(id: number): FranchiseRecordRow[] {
  const db = getDb();
  const rows = db
    .select({
      recordKey: recordEntries.recordKey,
      rank: recordEntries.rank,
      value: recordEntries.value,
      season: recordEntries.season,
      week: recordEntries.week,
      weekType: recordEntries.weekType,
    })
    .from(recordEntries)
    .where(and(eq(recordEntries.franchiseId, id), lte(recordEntries.rank, 3)))
    .all();

  return (rows as FranchiseRecordRow[]).sort((a, b) => a.rank - b.rank);
}
