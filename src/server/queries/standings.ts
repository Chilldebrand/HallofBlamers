import { computeDefaultSeason, winPct, scheduleHelp, sortRealStandings, computeLast5AndStreak, sortRealCareerStandings, computeCloseGames, sortLuckStandings } from '../../shared/standings';
import type { SeasonOption, StandingsSeasonSummary, StandingsCareerSummary, StandingsRealRow, TeamWeekResultRow, StandingsRealCareerRow, StandingsLuckRow, CloseGameRow } from '../../shared/standings';
export * from '../../shared/standings';
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../db/client";
import { careerStats, franchises, seasonStats, seasons, teamSeasons, teamWeek, weeks } from "../db/schema";

// ---------------------------------------------------------------------------
// Season picker
// ---------------------------------------------------------------------------



/** Newest first. */
export function getSeasonOptions(): SeasonOption[] {
  const db = getDb();
  return db
    .select({ season: seasons.season, status: seasons.status })
    .from(seasons)
    .all()
    .sort((a, b) => b.season - a.season);
}

/**
 * "Latest season with any completed games, else latest complete season."
 * `seasonsWithGames` is precomputed by the caller from team_week (any row
 * with `result !== null`) — kept as a Set param so this stays pure and
 * unit-testable without a DB. Falls back to the newest season at all if
 * nothing is ever 'complete' (a genuinely brand-new league).
 */


export function getDefaultStandingsSeason(): number | null {
  const db = getDb();
  const seasonOptions = getSeasonOptions();
  // Any team_week row with a decided result (never NULL) means that season has at least one
  // completed game — team_week rows exist for scheduled-but-unplayed weeks too (real 2026), with
  // `result` left NULL, so this can't just check row existence.
  const playedRows = db
    .select({ season: teamWeek.season })
    .from(teamWeek)
    .where(isNotNull(teamWeek.result))
    .all();
  const seasonsWithGames = new Set(playedRows.map((r) => r.season));
  return computeDefaultSeason(seasonOptions, seasonsWithGames);
}

// ---------------------------------------------------------------------------
// URL-param parsing (Task 29) — kept pure/exported so the page's ?tab=/?season=
// handling is unit-testable without a DB or a render harness.
// ---------------------------------------------------------------------------



/**
 * `?tab=allplay` is a dead URL from the pre-merge All-Play tab (Task 29 folded it into Luck) —
 * it must fall back to Luck, never 404 and never silently land on Real (a different tab entirely).
 * Any other/missing value defaults to Real. Pure.
 */




/**
 * Defensive `?season=` parsing: `"career"` selects career mode, a recognized season year selects
 * itself, and anything else — garbage, an unknown year, missing — falls back to `defaultSeason`.
 * Pure.
 */


// ---------------------------------------------------------------------------
// Header block: "2025 · complete · 14 weeks · 12 franchises"
// (docs/design/redesign-2026-08/README.md, Standings header)
// ---------------------------------------------------------------------------



export function getStandingsSeasonSummary(season: number): StandingsSeasonSummary | null {
  const db = getDb();
  const seasonRow = db.select({ status: seasons.status, teamCount: seasons.teamCount }).from(seasons).where(eq(seasons.season, season)).get();
  if (!seasonRow) return null;
  const weekRows = db.select({ week: weeks.week }).from(weeks).where(eq(weeks.season, season)).all();
  return { status: seasonRow.status, teamCount: seasonRow.teamCount, weekCount: weekRows.length };
}

/** Career-scope header line: "Career · N seasons · N franchises" — plain row counts, not a stat
 * rollup, so this reads `seasons`/`franchises` directly rather than career_stats. */


export function getStandingsCareerSummary(): StandingsCareerSummary {
  const db = getDb();
  const seasonRows = db.select({ season: seasons.season }).from(seasons).all();
  const franchiseRows = db.select({ id: franchises.id }).from(franchises).all();
  return { seasonCount: seasonRows.length, franchiseCount: franchiseRows.length };
}

// ---------------------------------------------------------------------------
// Shared: streak from a chronological W/L/T sequence
// ---------------------------------------------------------------------------



/** Trailing (current) streak — a tie resets it to null/0, mirroring engines/replay.ts's rule. Pure. */




/**
 * The one sign convention for every "did the schedule help you" stat on this page (the Luck
 * tab's Gap column, formerly also the standalone All-Play tab's Delta before Task 29 merged it
 * in): realWinPct - allplayWinPct. POSITIVE = the schedule flattered you — your record is better
 * than your all-play performance. Matches the luck total's direction (positive = schedule broke
 * your way). User-ruled 2026-08-04; the two tabs previously disagreed on sign, which read as two
 * different stats — merging them into one table in Task 29 makes that impossible to repeat.
 */


// ---------------------------------------------------------------------------
// Real tab
// ---------------------------------------------------------------------------





/**
 * Sorts by real final_standing when the season is complete (honoring an
 * already-decided order), otherwise by win% desc then points-for desc — the
 * "current standings" view for an in-progress season, since final_standing
 * stays ESPN's 0 placeholder for the season's entire duration. Pure.
 */


/** Last-5 record + current streak from a franchise's chronological team_week rows. Pure. */


export function getStandingsReal(season: number): StandingsRealRow[] {
  const db = getDb();
  const seasonRow = db.select({ status: seasons.status }).from(seasons).where(eq(seasons.season, season)).get();
  const seasonComplete = seasonRow?.status === "complete";

  const teamRows = db
    .select({
      franchiseId: teamSeasons.franchiseId,
      franchiseName: franchises.canonicalName,
      wins: teamSeasons.wins,
      losses: teamSeasons.losses,
      ties: teamSeasons.ties,
      pointsFor: teamSeasons.pointsFor,
      pointsAgainst: teamSeasons.pointsAgainst,
      finalStanding: teamSeasons.finalStanding,
      champion: seasonStats.champion,
      sacko: seasonStats.sacko,
    })
    .from(teamSeasons)
    .innerJoin(franchises, eq(teamSeasons.franchiseId, franchises.id))
    .leftJoin(seasonStats, and(eq(seasonStats.season, teamSeasons.season), eq(seasonStats.franchiseId, teamSeasons.franchiseId)))
    .where(eq(teamSeasons.season, season))
    .all();

  const weekRows: TeamWeekResultRow[] = db
    .select({ franchiseId: teamWeek.franchiseId, week: teamWeek.week, result: teamWeek.result })
    .from(teamWeek)
    .where(eq(teamWeek.season, season))
    .all();
  const weeksByFranchise = new Map<number, TeamWeekResultRow[]>();
  for (const r of weekRows) {
    const list = weeksByFranchise.get(r.franchiseId) ?? [];
    list.push(r);
    weeksByFranchise.set(r.franchiseId, list);
  }

  const rows: StandingsRealRow[] = teamRows.map((t) => {
    const franchiseWeeks = (weeksByFranchise.get(t.franchiseId) ?? []).slice().sort((a, b) => a.week - b.week);
    const { last5, last5Sequence, streak } = computeLast5AndStreak(franchiseWeeks.map((w) => w.result));
    return {
      franchiseId: t.franchiseId,
      franchiseName: t.franchiseName,
      wins: t.wins,
      losses: t.losses,
      ties: t.ties,
      pointsFor: t.pointsFor,
      pointsAgainst: t.pointsAgainst,
      finalStanding: t.finalStanding && t.finalStanding > 0 ? t.finalStanding : null,
      champion: t.champion ?? false,
      sacko: t.sacko ?? false,
      last5,
      last5Sequence,
      streak,
    };
  });

  return sortRealStandings(rows, seasonComplete);
}

// ---------------------------------------------------------------------------
// Real tab — Career scope (Task 29)
// ---------------------------------------------------------------------------



/**
 * All-time Real standings from career_stats, LEFT JOINed from `franchises` (not INNER from
 * career_stats) so a brand-new franchise with zero played games ever — no career_stats row at
 * all yet, see buildCareerStatsRows' `playedSeasonStats` filter in src/server/stats/build.ts —
 * still appears with honest zeros instead of silently vanishing. Same fallback pattern as
 * getFranchiseIndex. A season only ever reaches career_stats once it has >=1 played game, so an
 * all-upcoming preseason (2026 before kickoff) contributes nothing here — nothing to filter on
 * this side, the build already excluded it.
 */
export function getStandingsRealCareer(): StandingsRealCareerRow[] {
  const db = getDb();
  const franchiseRows = db.select({ id: franchises.id, name: franchises.canonicalName, active: franchises.active }).from(franchises).all();
  const careerRows = db.select().from(careerStats).all();
  const careerByFranchise = new Map(careerRows.map((c) => [c.franchiseId, c]));

  const rows = franchiseRows.map((f) => {
    const career = careerByFranchise.get(f.id);
    return {
      franchiseId: f.id,
      franchiseName: f.name,
      active: f.active,
      wins: career?.wins ?? 0,
      losses: career?.losses ?? 0,
      ties: career?.ties ?? 0,
      winPct: career?.winPct ?? 0,
      pointsFor: career?.pointsFor ?? 0,
      pointsAgainst: career?.pointsAgainst ?? 0,
      seasons: career?.seasons ?? 0,
      championships: career?.championships ?? 0,
      sackos: career?.sackos ?? 0,
    };
  });
  return sortRealCareerStandings(rows);
}

/**
 * Career Real sort: win% desc, then points-for desc (the same fallback `sortRealStandings` uses
 * for an in-progress season), then franchise id asc as a FINAL deterministic key. The season
 * version gets away without that third key because a win%+PF tie across a single season is
 * vanishingly rare; a multi-way career win% tie is real production data (four franchises tied at
 * .428571 career win%, distinct franchise ids) — without a total order, Array.prototype.sort's
 * result for equal comparator values is unspecified across engines/versions, and this table's
 * rank column (page.tsx) numbers rows by array position, so an unstable tie would reshuffle rank
 * numbers between renders. Pure, does not mutate its input (same contract as sortRealStandings).
 */


// ---------------------------------------------------------------------------
// Luck tab (Task 29: merged with the former All-Play tab — one table, one query, per season and
// career. `allplayW/L/T` below is the All-Play tab's old unique data, folded in here rather than
// duplicated in a second query.)
// ---------------------------------------------------------------------------





/** Close games (decided by <=5 points) won/lost, from team_week margins. Pure. */


export function getStandingsLuck(season: number): StandingsLuckRow[] {
  const db = getDb();
  const rows = db
    .select({
      franchiseId: teamSeasons.franchiseId,
      franchiseName: franchises.canonicalName,
      wins: teamSeasons.wins,
      losses: teamSeasons.losses,
      ties: teamSeasons.ties,
      allplayW: seasonStats.allplayW,
      allplayL: seasonStats.allplayL,
      allplayT: seasonStats.allplayT,
      luckTotal: seasonStats.luckTotal,
    })
    .from(teamSeasons)
    .innerJoin(franchises, eq(teamSeasons.franchiseId, franchises.id))
    .leftJoin(seasonStats, and(eq(seasonStats.season, teamSeasons.season), eq(seasonStats.franchiseId, teamSeasons.franchiseId)))
    .where(eq(teamSeasons.season, season))
    .all();

  const weekRows: CloseGameRow[] = db
    .select({ franchiseId: teamWeek.franchiseId, result: teamWeek.result, margin: teamWeek.margin })
    .from(teamWeek)
    .where(eq(teamWeek.season, season))
    .all();
  const weeksByFranchise = new Map<number, CloseGameRow[]>();
  for (const r of weekRows) {
    const list = weeksByFranchise.get(r.franchiseId) ?? [];
    list.push(r);
    weeksByFranchise.set(r.franchiseId, list);
  }

  const luckRows = rows.map((r) => {
    const allplayW = r.allplayW ?? 0;
    const allplayL = r.allplayL ?? 0;
    const allplayT = r.allplayT ?? 0;
    const realWinPct = winPct(r.wins, r.losses, r.ties);
    const allplayWinPct = winPct(allplayW, allplayL, allplayT);
    const { closeWins, closeLosses } = computeCloseGames(weeksByFranchise.get(r.franchiseId) ?? []);
    return {
      franchiseId: r.franchiseId,
      franchiseName: r.franchiseName,
      luckTotal: r.luckTotal ?? null,
      closeWins,
      closeLosses,
      realWinPct,
      allplayWinPct,
      allplayW,
      allplayL,
      allplayT,
      gap: scheduleHelp(realWinPct, allplayWinPct),
    };
  });
  return sortLuckStandings(luckRows);
}

/**
 * Luck sort (shared by both season and career — same `StandingsLuckRow` shape, same fix round 1
 * finding): luck total desc (null treated as 0, same as the pre-fix behavior), then gap desc as a
 * documented secondary — still a "did the schedule help you" direction, same `scheduleHelp()`
 * convention as luck itself — then franchise id asc as the FINAL deterministic key. Fixes the
 * same incidental-order risk `sortRealCareerStandings` fixes for the Real tab: two franchises can
 * land on an identical luck_total (and even identical gap), and without a total order,
 * Array.prototype.sort's tie-handling isn't guaranteed stable across engines. Pure.
 */


/**
 * All-time Luck standings (Task 29 Career scope). career_stats already carries the summed
 * wins/losses/ties/allplay-record/luck_total totals (see buildCareerStatsRows) — read those
 * directly rather than re-summing per-season rows. `closeWins`/`closeLosses` has no career_stats
 * analog (season_stats doesn't carry it either — getStandingsLuck derives it from team_week every
 * time), so this reuses the exact same `computeCloseGames` derivation over EVERY team_week row for
 * the franchise instead of just one season's — same pure function, same normalized-table source,
 * just unscoped. LEFT JOINed from `franchises` for the same zero-games-ever fallback as
 * getStandingsRealCareer.
 */
export function getStandingsLuckCareer(): StandingsLuckRow[] {
  const db = getDb();
  const franchiseRows = db.select({ id: franchises.id, name: franchises.canonicalName }).from(franchises).all();
  const careerRows = db.select().from(careerStats).all();
  const careerByFranchise = new Map(careerRows.map((c) => [c.franchiseId, c]));

  const weekRows: CloseGameRow[] = db.select({ franchiseId: teamWeek.franchiseId, result: teamWeek.result, margin: teamWeek.margin }).from(teamWeek).all();
  const weeksByFranchise = new Map<number, CloseGameRow[]>();
  for (const r of weekRows) {
    const list = weeksByFranchise.get(r.franchiseId) ?? [];
    list.push(r);
    weeksByFranchise.set(r.franchiseId, list);
  }

  const luckRows = franchiseRows.map((f) => {
    const career = careerByFranchise.get(f.id);
    const allplayW = career?.allplayW ?? 0;
    const allplayL = career?.allplayL ?? 0;
    const allplayT = career?.allplayT ?? 0;
    const realWinPct = winPct(career?.wins ?? 0, career?.losses ?? 0, career?.ties ?? 0);
    const allplayWinPct = winPct(allplayW, allplayL, allplayT);
    const { closeWins, closeLosses } = computeCloseGames(weeksByFranchise.get(f.id) ?? []);
    return {
      franchiseId: f.id,
      franchiseName: f.name,
      luckTotal: career?.luckTotal ?? null,
      closeWins,
      closeLosses,
      realWinPct,
      allplayWinPct,
      allplayW,
      allplayL,
      allplayT,
      gap: scheduleHelp(realWinPct, allplayWinPct),
    };
  });
  return sortLuckStandings(luckRows);
}
