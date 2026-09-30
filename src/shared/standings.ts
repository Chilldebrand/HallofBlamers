// Shared pure standings calculations and types; no database or framework imports.

export interface SeasonOption {
  season: number;
  status: "upcoming" | "active" | "complete";
}

export function computeDefaultSeason(seasonOptions: SeasonOption[], seasonsWithGames: Set<number>): number | null {
  if (seasonOptions.length === 0) return null;
  const sorted = [...seasonOptions].sort((a, b) => b.season - a.season);
  const withGames = sorted.find((s) => seasonsWithGames.has(s.season));
  if (withGames) return withGames.season;
  const complete = sorted.find((s) => s.status === "complete");
  return complete ? complete.season : sorted[0]!.season;
}

export type StandingsTab = "real" | "luck";

export function resolveStandingsTab(raw: string | undefined): StandingsTab {
  if (raw === "luck" || raw === "allplay") return "luck";
  return "real";
}

export type StandingsScope = number | "career";

export function resolveStandingsScope(raw: string | undefined, seasonOptions: SeasonOption[], defaultSeason: number): StandingsScope {
  if (raw === "career") return "career";
  const n = Number(raw);
  return seasonOptions.some((s) => s.season === n) ? n : defaultSeason;
}

export interface StandingsSeasonSummary {
  status: "upcoming" | "active" | "complete";
  teamCount: number;
  /** Total weeks scheduled for this season (regular + playoff), from the `weeks` table itself —
   * NOT `seasons.regSeasonWeeks`, which is regular season only and would undercount the header's
   * "N weeks" figure once playoff weeks are included. */
  weekCount: number;
}

export interface StandingsCareerSummary {
  seasonCount: number;
  franchiseCount: number;
}

export interface Streak {
  type: "W" | "L" | null;
  count: number;
}

export function computeStreak(resultsChronological: ("W" | "L" | "T")[]): Streak {
  let type: "W" | "L" | null = null;
  let count = 0;
  for (const r of resultsChronological) {
    if (r === "T") {
      type = null;
      count = 0;
      continue;
    }
    if (r === type) count += 1;
    else {
      type = r;
      count = 1;
    }
  }
  return { type, count };
}

export function winPct(wins: number, losses: number, ties: number): number {
  const games = wins + losses + ties;
  return games > 0 ? (wins + 0.5 * ties) / games : 0;
}

export function scheduleHelp(realWinPct: number, allplayWinPct: number): number {
  return realWinPct - allplayWinPct;
}

export interface StandingsRealRow {
  franchiseId: number;
  franchiseName: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  finalStanding: number | null; // null = not a real finish yet (0 placeholder or season incomplete)
  champion: boolean;
  sacko: boolean;
  last5: { wins: number; losses: number; ties: number };
  /** Chronological (oldest -> newest, trailing 5) — the README's "Last 5" column renders these
   * as five colored squares in order, not just the win/loss counts in `last5`. */
  last5Sequence: ("W" | "L" | "T")[];
  streak: Streak;
}

export interface TeamWeekResultRow {
  franchiseId: number;
  week: number;
  result: "W" | "L" | "T" | null;
}

export function sortRealStandings(rows: StandingsRealRow[], seasonComplete: boolean): StandingsRealRow[] {
  const sorted = [...rows];
  if (seasonComplete) {
    sorted.sort((a, b) => (a.finalStanding ?? Number.MAX_SAFE_INTEGER) - (b.finalStanding ?? Number.MAX_SAFE_INTEGER));
  } else {
    sorted.sort((a, b) => {
      const pctDiff = winPct(b.wins, b.losses, b.ties) - winPct(a.wins, a.losses, a.ties);
      if (pctDiff !== 0) return pctDiff;
      return b.pointsFor - a.pointsFor;
    });
  }
  return sorted;
}

export function computeLast5AndStreak(resultsChronological: ("W" | "L" | "T" | null)[]): {
  last5: { wins: number; losses: number; ties: number };
  /** The same trailing-5 window as `last5`, kept in order (oldest -> newest) — the README
   * "Last 5" column renders these as five colored squares, so the order matters, not just the
   * aggregate counts `last5` carries. */
  last5Sequence: ("W" | "L" | "T")[];
  streak: Streak;
} {
  const played = resultsChronological.filter((r): r is "W" | "L" | "T" => r !== null);
  const last5Results = played.slice(-5);
  const last5 = {
    wins: last5Results.filter((r) => r === "W").length,
    losses: last5Results.filter((r) => r === "L").length,
    ties: last5Results.filter((r) => r === "T").length,
  };
  return { last5, last5Sequence: last5Results, streak: computeStreak(played) };
}

export interface StandingsRealCareerRow {
  franchiseId: number;
  franchiseName: string;
  /** franchises.active — departed franchises are included (career is history) and marked in the
   * UI the same way the /franchises index marks them. */
  active: boolean;
  wins: number;
  losses: number;
  ties: number;
  winPct: number;
  pointsFor: number;
  pointsAgainst: number;
  seasons: number;
  championships: number;
  sackos: number;
}

export function sortRealCareerStandings(rows: StandingsRealCareerRow[]): StandingsRealCareerRow[] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    if (b.winPct !== a.winPct) return b.winPct - a.winPct;
    if (b.pointsFor !== a.pointsFor) return b.pointsFor - a.pointsFor;
    return a.franchiseId - b.franchiseId;
  });
  return sorted;
}

export interface StandingsLuckRow {
  franchiseId: number;
  franchiseName: string;
  luckTotal: number | null;
  closeWins: number;
  closeLosses: number;
  realWinPct: number;
  allplayWinPct: number;
  allplayW: number;
  allplayL: number;
  allplayT: number;
  /** scheduleHelp(): positive = the schedule flattered you. */
  gap: number;
}

export interface CloseGameRow {
  franchiseId: number;
  result: "W" | "L" | "T" | null;
  margin: number | null;
}

export function computeCloseGames(rows: CloseGameRow[]): { closeWins: number; closeLosses: number } {
  let closeWins = 0;
  let closeLosses = 0;
  for (const r of rows) {
    if (r.margin === null || r.result === null || r.result === "T") continue;
    if (Math.abs(r.margin) <= 5) {
      if (r.result === "W") closeWins += 1;
      else closeLosses += 1;
    }
  }
  return { closeWins, closeLosses };
}

export function sortLuckStandings(rows: StandingsLuckRow[]): StandingsLuckRow[] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    const luckDiff = (b.luckTotal ?? 0) - (a.luckTotal ?? 0);
    if (luckDiff !== 0) return luckDiff;
    if (b.gap !== a.gap) return b.gap - a.gap;
    return a.franchiseId - b.franchiseId;
  });
  return sorted;
}
