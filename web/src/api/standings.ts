import type { CareerStat, SeasonStat, TeamSeason } from "../../../src/server/db/schema";
import {
  computeDefaultSeason, computeLast5AndStreak, computeCloseGames, winPct, scheduleHelp,
  sortRealStandings, sortRealCareerStandings, sortLuckStandings, resolveStandingsScope, resolveStandingsTab,
  type SeasonOption, type StandingsRealRow, type StandingsRealCareerRow, type StandingsLuckRow,
} from "../../../src/shared/standings";

type RecordFields = "wins" | "losses" | "ties" | "pointsFor" | "pointsAgainst";
export interface StandingsSource {
  seasonOptions: SeasonOption[];
  seasons: { season: number; status: string; teamCount: number }[];
  franchises: { id: number; canonicalName: string; active: boolean }[];
  teamSeasons: Pick<TeamSeason, RecordFields | "season" | "franchiseId" | "finalStanding">[];
  seasonStats: Pick<SeasonStat, "season" | "franchiseId" | "champion" | "sacko" | "allplayW" | "allplayL" | "allplayT" | "luckTotal">[];
  careerStats: Pick<CareerStat, RecordFields | "franchiseId" | "winPct" | "seasons" | "championships" | "sackos" | "allplayW" | "allplayL" | "allplayT" | "luckTotal">[];
  weeks: { season: number; week: number }[];
  weekResults: { franchiseId: number; season: number; week: number; result: "W" | "L" | "T" | null; margin: number | null }[];
}

export function buildStandings(source: StandingsSource, params: { season?: string; tab?: string }) {
  const defaultSeason = computeDefaultSeason(source.seasonOptions, new Set(source.weekResults.filter(w => w.result !== null).map(w => w.season))) ?? source.seasonOptions[0]?.season ?? 0;
  const scope = resolveStandingsScope(params.season, source.seasonOptions, defaultSeason);
  const tab = resolveStandingsTab(params.tab);
  const season = source.seasons.find(s => s.season === scope);
  const teamRows = source.teamSeasons.filter(t => t.season === scope);
  const franchiseById = new Map(source.franchises.map(f => [f.id, f]));
  const statsById = new Map(source.seasonStats.filter(s => s.season === scope).map(s => [s.franchiseId, s]));
  const careerById = new Map(source.careerStats.map(c => [c.franchiseId, c]));
  const resultRows = source.weekResults.filter(w => scope === "career" || w.season === scope);
  const real: StandingsRealRow[] = sortRealStandings(teamRows.map(t => {
    const stats = statsById.get(t.franchiseId);
    const games = resultRows.filter(w => w.franchiseId === t.franchiseId).sort((a,b) => a.week-b.week);
    return {
      franchiseId: t.franchiseId, franchiseName: franchiseById.get(t.franchiseId)?.canonicalName ?? "—",
      wins:t.wins,losses:t.losses,ties:t.ties,pointsFor:t.pointsFor,pointsAgainst:t.pointsAgainst,
      finalStanding:t.finalStanding && t.finalStanding > 0 ? t.finalStanding : null,
      champion:stats?.champion ?? false,sacko:stats?.sacko ?? false,...computeLast5AndStreak(games.map(g=>g.result)),
    };
  }), season?.status === "complete");
  const career: StandingsRealCareerRow[] = sortRealCareerStandings(source.franchises.map(f => {
    const c=careerById.get(f.id);
    return {franchiseId:f.id,franchiseName:f.canonicalName,active:f.active,wins:c?.wins??0,losses:c?.losses??0,ties:c?.ties??0,
      winPct:c?.winPct??0,pointsFor:c?.pointsFor??0,pointsAgainst:c?.pointsAgainst??0,seasons:c?.seasons??0,championships:c?.championships??0,sackos:c?.sackos??0};
  }));
  const luck: StandingsLuckRow[] = sortLuckStandings((scope === "career" ? source.franchises : teamRows.map(t=>franchiseById.get(t.franchiseId)!)).map(f => {
    const record=scope === "career" ? careerById.get(f.id) : teamRows.find(t=>t.franchiseId===f.id);
    const stats=scope === "career" ? careerById.get(f.id) : statsById.get(f.id);
    const realWinPct=winPct(record?.wins??0,record?.losses??0,record?.ties??0);
    const allplayW=stats?.allplayW??0, allplayL=stats?.allplayL??0, allplayT=stats?.allplayT??0;
    const allplayWinPct=winPct(allplayW,allplayL,allplayT);
    return {franchiseId:f.id,franchiseName:f.canonicalName,luckTotal:stats?.luckTotal??null,
      ...computeCloseGames(resultRows.filter(w=>w.franchiseId===f.id)),realWinPct,allplayWinPct,allplayW,allplayL,allplayT,gap:scheduleHelp(realWinPct,allplayWinPct)};
  }));
  return {scope,tab,real,career,luck,seasonStatus:season?.status as SeasonOption["status"] | undefined,seasonOptions:source.seasonOptions,
    summary:season ? {status:season.status,teamCount:season.teamCount,weekCount:source.weeks.filter(w=>w.season===scope).length} : null,
    careerSummary:{seasonCount:source.seasons.length,franchiseCount:source.franchises.length}};
}
export type StandingsModel = ReturnType<typeof buildStandings>;
