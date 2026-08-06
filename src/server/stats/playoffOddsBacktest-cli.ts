/**
 * Task 52's HONESTY CORE (brief item 2): replays every real, COMPLETE historical season from each
 * regular-season week boundary, simulates the rest of that season via the Monte Carlo engine
 * (`src/engines/playoffOdds.ts`) fed a LEAVE-ONE-SEASON-OUT calibration (fit excluding the very
 * season being evaluated — the same discipline `src/engines/eloCalibration.ts`'s own validation
 * used, reused here rather than re-invented), and reports how well the resulting P(playoffs)
 * predictions calibrate against what ACTUALLY happened (`team_seasons.made_playoffs`, ESPN's own
 * real `WINNERS_BRACKET` presence — see normalize.ts).
 *
 * THE GATE (this task's brief): the Monte Carlo model's Brier score must be STRICTLY LOWER than a
 * naive "current-standings-hold-forever" baseline's (predict 1 for every franchise currently inside
 * the playoff cutline at that boundary, 0 for everyone else, using the SAME tiebreak the engine
 * itself uses — `rankFranchisesForSeeding`) — or nothing ships beyond the engine + this report
 * (`DONE_WITH_CONCERNS`, no build stage, no UI). Printed explicitly below as PASS/FAIL, same
 * convention `backtest-cli.ts`'s own win-probability gate uses.
 *
 * WHY LEAVE-ONE-SEASON-OUT HERE (unlike `backtest-cli.ts`'s in-sample win-probability backtest):
 * that backtest evaluates a single number (P(this game's winner)) whose calibration is fit against
 * all available finals at once — acceptable for this descriptive two-parameter calibration. THIS backtest evaluates something that compounds errors across
 * MANY simulated games per sample and is graded per-SEASON — fitting on a season's own outcomes and
 * then grading predictions made ABOUT that same season would leak information the real production
 * calibration (fit on 11 seasons, none of which is "the season being forecast" in the same
 * information-leaking sense, since the calibration doesn't change mid-season) could never see. LOSO
 * is cheap here (`fitEloCalibration` over a few hundred filtered samples, single-digit Newton-
 * Raphson iterations) so there's no excuse to skip it.
 *
 * SAFETY: same discipline as `backtest-cli.ts` — the source DB (`--source`, else `DATABASE_PATH`,
 * else `./data/league.db`) is opened `{ readonly: true }` and copied via `VACUUM INTO` to a scratch
 * temp file; every migration/stats:build/query in this script runs against that COPY only, deleted
 * before exit (success or failure).
 *
 * Usage: `npm run playoffodds:backtest [-- --source <path>] [-- --runs 10000] [-- --min-week 1]`
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import {
  computePlayoffOddsCalibrationBuckets,
  ELO_SEASON_REGRESSION_FACTOR,
  ELO_START,
  evaluatePlayoffOddsGate,
  fitEloCalibration,
  rankFranchisesForSeeding,
  runPlayoffOddsSimulation,
  type CalibrationBucket,
  type EloCalibration,
  type PlayoffOddsBacktestOutcome,
  type PlayoffOddsMatchup,
  type PlayoffOddsStanding,
} from "../../engines";
import { createDb } from "../db/client";
import { runMigrations } from "../db/migrate";
import { eloHistory, matchups, seasons, teamSeasons, teamWeek, weeks } from "../db/schema";
import { runStatBuild } from "./build";

export interface CliArgs {
  source: string;
  runs: number;
  minWeek: number;
  bucketWidth: number;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  let source = process.env.DATABASE_PATH ?? "./data/league.db";
  let runs = 10_000;
  let minWeek = 1;
  let bucketWidth = 0.1;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--source") {
      const value = argv[i + 1];
      if (!value) throw new Error("playoffodds:backtest: --source requires a value");
      source = value;
      i++;
    } else if (arg === "--runs") {
      const value = argv[i + 1];
      if (!value) throw new Error("playoffodds:backtest: --runs requires a value");
      runs = Number(value);
      if (!Number.isFinite(runs) || runs <= 0) throw new Error(`playoffodds:backtest: --runs must be a positive number, got "${value}"`);
      i++;
    } else if (arg === "--min-week") {
      const value = argv[i + 1];
      if (!value) throw new Error("playoffodds:backtest: --min-week requires a value");
      minWeek = Number(value);
      if (!Number.isFinite(minWeek) || minWeek < 0) throw new Error(`playoffodds:backtest: --min-week must be >= 0, got "${value}"`);
      i++;
    } else if (arg === "--bucket-width") {
      const value = argv[i + 1];
      if (!value) throw new Error("playoffodds:backtest: --bucket-width requires a value");
      bucketWidth = Number(value);
      if (!Number.isFinite(bucketWidth) || bucketWidth <= 0 || bucketWidth > 1) {
        throw new Error(`playoffodds:backtest: --bucket-width must be a number in (0, 1], got "${value}"`);
      }
      i++;
    } else {
      throw new Error(`playoffodds:backtest: unknown argument "${arg}"`);
    }
  }

  return { source, runs, minWeek, bucketWidth };
}

function copyDatabaseReadOnly(sourcePath: string, destPath: string): void {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    source.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
}

// ---------------------------------------------------------------------------
// Calibration samples, tagged by season — a season-aware sibling of
// `src/server/queries/winProbability.ts`'s `loadEloCalibrationSamples` (same join, same no-leakage
// discipline: `elo_history.elo_pre`, strictly BEFORE that game, never `elo_post`). That function
// doesn't expose `season` per sample (it doesn't need to — the live query layer always fits on
// EVERY sample at once), so this is a small, deliberate duplication rather than a shared helper,
// to support this backtest's leave-one-season-out exclusion.
// ---------------------------------------------------------------------------

interface SeasonTaggedCalibrationSample {
  season: number;
  eloDiff: number;
  result: 0 | 0.5 | 1;
}

function buildCalibrationSamplesBySeason(
  db: ReturnType<typeof createDb>["db"],
): SeasonTaggedCalibrationSample[] {
  const finalMatchupRows = db
    .select({
      season: matchups.season,
      week: matchups.week,
      homeTeamSeasonId: matchups.homeTeamSeasonId,
      awayTeamSeasonId: matchups.awayTeamSeasonId,
      winner: matchups.winner,
      isFinal: matchups.isFinal,
    })
    .from(matchups)
    .all()
    .filter((m) => m.isFinal && m.awayTeamSeasonId !== null && m.winner !== null);

  const teamSeasonRows = db.select({ id: teamSeasons.id, franchiseId: teamSeasons.franchiseId }).from(teamSeasons).all();
  const franchiseByTeamSeason = new Map(teamSeasonRows.map((t) => [t.id, t.franchiseId]));

  const eloRows = db.select({ franchiseId: eloHistory.franchiseId, season: eloHistory.season, week: eloHistory.week, eloPre: eloHistory.eloPre }).from(eloHistory).all();
  const eloPreByKey = new Map(eloRows.map((r) => [`${r.franchiseId}:${r.season}:${r.week}`, r.eloPre]));

  const samples: SeasonTaggedCalibrationSample[] = [];
  for (const m of finalMatchupRows) {
    const homeFranchiseId = franchiseByTeamSeason.get(m.homeTeamSeasonId);
    const awayFranchiseId = franchiseByTeamSeason.get(m.awayTeamSeasonId!);
    if (homeFranchiseId === undefined || awayFranchiseId === undefined) continue;
    const eloPreHome = eloPreByKey.get(`${homeFranchiseId}:${m.season}:${m.week}`);
    const eloPreAway = eloPreByKey.get(`${awayFranchiseId}:${m.season}:${m.week}`);
    if (eloPreHome === undefined || eloPreAway === undefined) continue;
    const result: 0 | 0.5 | 1 = m.winner === "home" ? 1 : m.winner === "away" ? 0 : 0.5;
    samples.push({ season: m.season, eloDiff: eloPreHome - eloPreAway, result });
  }
  return samples;
}

// ---------------------------------------------------------------------------
// Elo as of a week boundary (post-that-week rating) — the in-memory sibling of
// `src/server/queries/winProbability.ts`'s `resolvePreGameElo`, operating over an already-loaded
// row array instead of issuing its own query per franchise (this backtest calls it thousands of
// times, once per (season, boundary, franchise) triple).
// ---------------------------------------------------------------------------

interface EloRow {
  franchiseId: number;
  season: number;
  week: number;
  eloPost: number;
}

function resolveEloAsOfBoundary(eloRowsByFranchise: Map<number, EloRow[]>, franchiseId: number, season: number, week: number): number {
  const rows = eloRowsByFranchise.get(franchiseId);
  if (!rows) return ELO_START;
  let best: EloRow | null = null;
  for (const r of rows) {
    if (r.season > season) continue;
    if (r.season === season && r.week > week) continue;
    if (!best || r.season > best.season || (r.season === best.season && r.week > best.week)) best = r;
  }
  if (!best) return ELO_START;
  if (best.season < season) return ELO_START + (best.eloPost - ELO_START) * ELO_SEASON_REGRESSION_FACTOR;
  return best.eloPost;
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

export interface PlayoffOddsBacktestReport {
  sampleCount: number;
  seasonsEvaluated: number[];
  runsPerBoundary: number;
  mcBrierScore: number;
  naiveBrierScore: number;
  gatePass: boolean;
  mcCalibration: CalibrationBucket[];
  naiveCalibration: CalibrationBucket[];
}

export function runPlayoffOddsBacktest(db: ReturnType<typeof createDb>["db"], opts: { runs: number; minWeek: number; bucketWidth: number }): PlayoffOddsBacktestReport {
  const seasonRows = db.select({ season: seasons.season, playoffFormatJson: seasons.playoffFormatJson, teamCount: seasons.teamCount, regSeasonWeeks: seasons.regSeasonWeeks, status: seasons.status }).from(seasons).all();
  const completeSeasons = seasonRows.filter((s) => s.status === "complete");

  const weekRows = db.select({ season: weeks.season, week: weeks.week, weekType: weeks.weekType }).from(weeks).all();
  const regularWeekSet = new Set(weekRows.filter((w) => w.weekType === "regular").map((w) => `${w.season}:${w.week}`));

  const matchupRows = db.select({ season: matchups.season, week: matchups.week, homeTeamSeasonId: matchups.homeTeamSeasonId, awayTeamSeasonId: matchups.awayTeamSeasonId }).from(matchups).all();
  const teamSeasonRows = db.select({ id: teamSeasons.id, season: teamSeasons.season, franchiseId: teamSeasons.franchiseId, madePlayoffs: teamSeasons.madePlayoffs }).from(teamSeasons).all();
  const franchiseByTeamSeason = new Map(teamSeasonRows.map((t) => [t.id, t.franchiseId]));
  const madePlayoffsByKey = new Map(teamSeasonRows.map((t) => [`${t.season}:${t.franchiseId}`, t.madePlayoffs]));

  const teamWeekRows = db.select({ season: teamWeek.season, week: teamWeek.week, franchiseId: teamWeek.franchiseId, score: teamWeek.score, result: teamWeek.result, weekType: teamWeek.weekType }).from(teamWeek).all();

  const eloRowsAll = db.select({ franchiseId: eloHistory.franchiseId, season: eloHistory.season, week: eloHistory.week, eloPost: eloHistory.eloPost }).from(eloHistory).all();
  const eloRowsByFranchise = new Map<number, EloRow[]>();
  for (const r of eloRowsAll) {
    const list = eloRowsByFranchise.get(r.franchiseId) ?? [];
    list.push(r);
    eloRowsByFranchise.set(r.franchiseId, list);
  }

  const allCalibrationSamples = buildCalibrationSamplesBySeason(db);

  const mcOutcomes: PlayoffOddsBacktestOutcome[] = [];
  const naiveOutcomes: PlayoffOddsBacktestOutcome[] = [];
  const seasonsEvaluated: number[] = [];

  for (const s of completeSeasons) {
    const playoffFormat = s.playoffFormatJson as { playoffTeamCount?: unknown } | null | undefined;
    const playoffTeamCount = typeof playoffFormat?.playoffTeamCount === "number" ? playoffFormat.playoffTeamCount : null;
    if (playoffTeamCount === null) continue; // honest skip — no real format to evaluate against

    const franchisesThisSeason = teamSeasonRows.filter((t) => t.season === s.season);
    if (franchisesThisSeason.length === 0) continue;

    // LEAVE-ONE-SEASON-OUT: fit excluding every sample from THIS season.
    const calibration: EloCalibration = fitEloCalibration(
      allCalibrationSamples.filter((c) => c.season !== s.season).map((c) => ({ eloDiff: c.eloDiff, result: c.result })),
    );

    let seasonHadAnyBoundary = false;

    for (let boundaryWeek = opts.minWeek; boundaryWeek < s.regSeasonWeeks; boundaryWeek++) {
      const remainingMatchups: PlayoffOddsMatchup[] = matchupRows
        .filter((m) => m.season === s.season && m.week > boundaryWeek && m.awayTeamSeasonId !== null && regularWeekSet.has(`${m.season}:${m.week}`))
        .map((m) => ({ homeFranchiseId: franchiseByTeamSeason.get(m.homeTeamSeasonId)!, awayFranchiseId: franchiseByTeamSeason.get(m.awayTeamSeasonId!)! }))
        .filter((m) => m.homeFranchiseId !== undefined && m.awayFranchiseId !== undefined);

      if (remainingMatchups.length === 0) continue; // nothing left to forecast at this boundary

      const standings: PlayoffOddsStanding[] = franchisesThisSeason.map((f) => {
        const played = teamWeekRows.filter((tw) => tw.season === s.season && tw.franchiseId === f.franchiseId && tw.weekType === "regular" && tw.week <= boundaryWeek);
        const wins = played.filter((r) => r.result === "W").length;
        const losses = played.filter((r) => r.result === "L").length;
        const ties = played.filter((r) => r.result === "T").length;
        const pointsFor = played.reduce((sum, r) => sum + r.score, 0);
        return { franchiseId: f.franchiseId, wins, losses, ties, pointsFor };
      });

      const eloByFranchise = new Map(standings.map((st) => [st.franchiseId, resolveEloAsOfBoundary(eloRowsByFranchise, st.franchiseId, s.season, boundaryWeek)]));

      const seed = s.season * 1000 + boundaryWeek;
      const mcResult = runPlayoffOddsSimulation(
        { standings, remainingMatchups, eloByFranchise, eloCalibration: calibration, format: { teamCount: s.teamCount, playoffTeamCount } },
        seed,
        opts.runs,
      );

      const naiveOrder = rankFranchisesForSeeding(standings);
      const naiveTop = new Set(naiveOrder.slice(0, Math.max(0, Math.min(playoffTeamCount, naiveOrder.length))));

      for (const f of mcResult.franchises) {
        const actual = madePlayoffsByKey.get(`${s.season}:${f.franchiseId}`);
        if (actual === undefined) continue; // shouldn't happen for real data — defensive skip only
        mcOutcomes.push({ predictedPlayoffProbability: f.playoffProbability, actualMadePlayoffs: actual ? 1 : 0 });
        naiveOutcomes.push({ predictedPlayoffProbability: naiveTop.has(f.franchiseId) ? 1 : 0, actualMadePlayoffs: actual ? 1 : 0 });
      }
      seasonHadAnyBoundary = true;
    }

    if (seasonHadAnyBoundary) seasonsEvaluated.push(s.season);
  }

  const gate = evaluatePlayoffOddsGate(mcOutcomes, naiveOutcomes);

  return {
    sampleCount: mcOutcomes.length,
    seasonsEvaluated,
    runsPerBoundary: opts.runs,
    mcBrierScore: gate.mcBrierScore,
    naiveBrierScore: gate.naiveBrierScore,
    gatePass: gate.gatePass,
    mcCalibration: computePlayoffOddsCalibrationBuckets(mcOutcomes, opts.bucketWidth),
    naiveCalibration: computePlayoffOddsCalibrationBuckets(naiveOutcomes, opts.bucketWidth),
  };
}

function formatBucketTable(label: string, buckets: CalibrationBucket[]): string {
  const lines = [`  ${label}:`, "    bucket      n   mean predicted   actual playoff rate"];
  for (const b of buckets) {
    if (b.n === 0) continue; // playoff-odds predictions cluster heavily near 0%/100% — skip empty buckets for a readable table
    const predicted = `${(b.meanPredicted * 100).toFixed(1).padStart(6)}%`;
    const actual = `${(b.actualWinRate * 100).toFixed(1).padStart(6)}%`;
    lines.push(`    ${b.label.padEnd(9)} ${String(b.n).padStart(4)}   ${predicted}          ${actual}`);
  }
  return lines.join("\n");
}

function printReport(report: PlayoffOddsBacktestReport): void {
  const seasonLabel = report.seasonsEvaluated.length > 0 ? `seasons ${Math.min(...report.seasonsEvaluated)}-${Math.max(...report.seasonsEvaluated)} (${report.seasonsEvaluated.length} seasons)` : "no seasons";
  console.log(`\nPlayoff-odds backtest — ${report.sampleCount} (season, week-boundary, franchise) samples across ${seasonLabel}, ${report.runsPerBoundary} MC runs/boundary\n`);
  console.log(`Brier score (lower is better; 0 = perfect, 0.25 = an always-50% baseline's score against a 50/50 split):`);
  console.log(`  Monte Carlo model (leave-one-season-out calibration): ${report.mcBrierScore.toFixed(4)}`);
  console.log(`  naive baseline (current standings hold forever):      ${report.naiveBrierScore.toFixed(4)}`);
  console.log(`\nGATE (Monte Carlo must beat the naive baseline): ${report.gatePass ? "PASS" : "FAIL"}\n`);
  console.log(formatBucketTable("Monte Carlo calibration", report.mcCalibration));
  console.log();
  console.log(formatBucketTable("naive baseline calibration", report.naiveCalibration));
  console.log();
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const resolvedSource = path.resolve(args.source);
  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`playoffodds:backtest: source database not found at ${resolvedSource}`);
  }

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ffootball-playoffodds-backtest-"));
  const scratchPath = path.join(scratchDir, "backtest.db");

  try {
    console.log(`Copying ${resolvedSource} (read-only) -> scratch copy at ${scratchPath} ...`);
    copyDatabaseReadOnly(resolvedSource, scratchPath);

    const { db, sqlite } = createDb(scratchPath);
    try {
      runMigrations(db);
      console.log("Running stats:build on the scratch copy (forced) ...");
      const buildResult = runStatBuild(db, { force: true });
      if (buildResult.status !== "ok") {
        throw new Error(`playoffodds:backtest: stats:build against the scratch copy failed: ${buildResult.errorText ?? "(no error text)"}`);
      }

      console.log("Running Monte Carlo backtest across every complete season's week boundaries ...");
      const report = runPlayoffOddsBacktest(db, { runs: args.runs, minWeek: args.minWeek, bucketWidth: args.bucketWidth });
      printReport(report);
    } finally {
      sqlite.close();
    }
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
