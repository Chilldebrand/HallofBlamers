/**
 * Task 32 win-probability backtest — the HONESTY CORE of this task, per its brief. Evaluates the
 * model's PRE-GAME output against every historical FINAL, real (non-bye) matchup this league has
 * ever played, and reports calibration + Brier score against two baselines: a coin-flip (always
 * 0.5) and pure Elo (`eloExpected` on the SAME pre-game Elo ratings the model itself uses).
 *
 * WHY PRE-GAME ONLY — READ THIS BEFORE READING THE NUMBERS BELOW: this database has no historical
 * intra-week snapshots. `roster_slots` stores only the FINAL per-player-week point totals, never a
 * series of "as of 3pm Sunday, 4 of 9 starters have played" states. There is no ground truth to
 * backtest a mid-week, partially-played probability against — that evidence only starts
 * accumulating once the live layer records real in-progress weeks going forward. See
 * `src/engines/winProbability.ts`'s module docstring for the fuller explanation.
 *
 * STRUCTURAL CONSEQUENCE (also documented on the engine, verified empirically by this script's own
 * output): PRE-GAME, this model's blend weight on the score-based term is exactly 0 — every team
 * in a season shares the same starting-slot composition, so both sides' pre-game remaining-score
 * distributions are identical and contribute nothing to the diff. That means "our model" and "pure
 * Elo" are mathematically the SAME prediction pre-game, and this backtest's numbers for the two
 * will match (up to float rounding) BY CONSTRUCTION, not because the backtest failed to
 * discriminate them. That's expected, not a bug — see the report this script prints.
 *
 * SAFETY: the source DB (`--source`, else `DATABASE_PATH`, else `./data/league.db`) is opened
 * `{ readonly: true }` and copied via SQLite's `VACUUM INTO` — a single, source-untouched
 * snapshot — to a scratch temp file. Every migration/stats:build/query in this script runs against
 * that COPY only; the scratch file is deleted before exit (success or failure).
 *
 * Usage: `npm run winprob:backtest [-- --source <path>] [-- --bucket-width 0.1]`
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { eq, and, isNotNull } from "drizzle-orm";
import {
  computeBrierScore,
  computeCalibrationBuckets,
  eloExpected,
  winProbability,
  type BacktestOutcome,
  type CalibrationBucket,
  type SlotScoringCalibration,
  type WinProbabilityTeamState,
} from "../../engines";
import { createDb } from "../db/client";
import { runMigrations } from "../db/migrate";
import { eloHistory, matchups, seasons, teamSeasons } from "../db/schema";
import { loadSlotScoringCalibration } from "../queries/winProbability";
import { resolveStartingSlotCounts, runStatBuild } from "./build";

export interface CliArgs {
  source: string;
  bucketWidth: number;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  let source = process.env.DATABASE_PATH ?? "./data/league.db";
  let bucketWidth = 0.1;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--source") {
      const value = argv[i + 1];
      if (!value) throw new Error("winprob:backtest: --source requires a value");
      source = value;
      i++;
    } else if (arg === "--bucket-width") {
      const value = argv[i + 1];
      if (!value) throw new Error("winprob:backtest: --bucket-width requires a value");
      bucketWidth = Number(value);
      if (!Number.isFinite(bucketWidth) || bucketWidth <= 0 || bucketWidth > 1) {
        throw new Error(`winprob:backtest: --bucket-width must be a number in (0, 1], got "${value}"`);
      }
      i++;
    } else {
      throw new Error(`winprob:backtest: unknown argument "${arg}"`);
    }
  }

  return { source, bucketWidth };
}

/** Copies `sourcePath` (opened read-only — never mutated) to `destPath` via `VACUUM INTO`, a
 * single-statement, WAL-safe, fully consistent snapshot. */
function copyDatabaseReadOnly(sourcePath: string, destPath: string): void {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    // Escaped by doubling any single quote — VACUUM INTO takes its destination as a string
    // literal, not a bound parameter (SQLite doesn't support parameter binding in this position).
    source.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
}

export interface BacktestReport {
  matchupCount: number;
  /** Null only when `matchupCount === 0` — never fabricated as some placeholder range. */
  seasonRange: { min: number; max: number } | null;
  ourModel: { brierScore: number; calibration: CalibrationBucket[] };
  pureElo: { brierScore: number; calibration: CalibrationBucket[] };
  coinFlip: { brierScore: number };
}

/** The core computation, separated from CLI/IO concerns so it can be exercised directly. Takes an
 * already-built `Db` (migrated + stats:build already run) — same reasoning as every other
 * DB-facing module in this repo (`src/server/queries/*`): the DB wiring stays thin, the logic
 * underneath it is what gets tested. */
export function runBacktest(db: ReturnType<typeof createDb>["db"], bucketWidth: number): BacktestReport {
  const calibration: SlotScoringCalibration = loadSlotScoringCalibration(db);

  const seasonRows = db.select({ season: seasons.season, settingsJson: seasons.settingsJson }).from(seasons).all();
  const slotCountsBySeason = new Map<number, Record<string, number> | null>();
  const ignoredWarnings: string[] = [];
  for (const s of seasonRows) {
    slotCountsBySeason.set(s.season, resolveStartingSlotCounts(s.season, s.settingsJson, ignoredWarnings));
  }

  const teamSeasonRows = db.select({ id: teamSeasons.id, franchiseId: teamSeasons.franchiseId }).from(teamSeasons).all();
  const franchiseByTeamSeason = new Map(teamSeasonRows.map((t) => [t.id, t.franchiseId]));

  const eloRows = db
    .select({ franchiseId: eloHistory.franchiseId, season: eloHistory.season, week: eloHistory.week, eloPre: eloHistory.eloPre })
    .from(eloHistory)
    .all();
  const eloPreByKey = new Map(eloRows.map((r) => [`${r.franchiseId}:${r.season}:${r.week}`, r.eloPre]));

  const finalMatchupRows = db
    .select({
      season: matchups.season,
      week: matchups.week,
      homeTeamSeasonId: matchups.homeTeamSeasonId,
      awayTeamSeasonId: matchups.awayTeamSeasonId,
      winner: matchups.winner,
    })
    .from(matchups)
    .where(and(eq(matchups.isFinal, true), isNotNull(matchups.awayTeamSeasonId)))
    .all();

  const ourModelOutcomes: BacktestOutcome[] = [];
  const pureEloOutcomes: BacktestOutcome[] = [];
  const coinFlipOutcomes: BacktestOutcome[] = [];
  let seasonMin = Infinity;
  let seasonMax = -Infinity;

  for (const m of finalMatchupRows) {
    if (m.awayTeamSeasonId === null || m.winner === null) continue; // byes/undecided already excluded by the query, defensive narrowing only
    const homeFranchiseId = franchiseByTeamSeason.get(m.homeTeamSeasonId);
    const awayFranchiseId = franchiseByTeamSeason.get(m.awayTeamSeasonId);
    if (homeFranchiseId === undefined || awayFranchiseId === undefined) continue; // orphaned team_season reference — shouldn't happen for real data

    const eloPreHome = eloPreByKey.get(`${homeFranchiseId}:${m.season}:${m.week}`);
    const eloPreAway = eloPreByKey.get(`${awayFranchiseId}:${m.season}:${m.week}`);
    if (eloPreHome === undefined || eloPreAway === undefined) continue; // replay() didn't process this game (shouldn't happen for a real final, non-bye matchup)

    seasonMin = Math.min(seasonMin, m.season);
    seasonMax = Math.max(seasonMax, m.season);

    // PRE-GAME state: nobody has scored yet, every configured starting slot is "remaining" — see
    // this module's docstring for why this makes the score-based term contribute nothing.
    const slotCounts = slotCountsBySeason.get(m.season) ?? {};
    const home: WinProbabilityTeamState = { score: 0, eloPre: eloPreHome, startersPlayed: 0, remainingBySlot: slotCounts };
    const away: WinProbabilityTeamState = { score: 0, eloPre: eloPreAway, startersPlayed: 0, remainingBySlot: slotCounts };

    const actualHomeResult: 0 | 0.5 | 1 = m.winner === "home" ? 1 : m.winner === "away" ? 0 : 0.5;

    ourModelOutcomes.push({ predictedHomeWinProbability: winProbability({ home, away }, calibration), actualHomeResult });
    pureEloOutcomes.push({ predictedHomeWinProbability: eloExpected(eloPreHome, eloPreAway), actualHomeResult });
    coinFlipOutcomes.push({ predictedHomeWinProbability: 0.5, actualHomeResult });
  }

  return {
    matchupCount: ourModelOutcomes.length,
    seasonRange: ourModelOutcomes.length > 0 ? { min: seasonMin, max: seasonMax } : null,
    ourModel: { brierScore: computeBrierScore(ourModelOutcomes), calibration: computeCalibrationBuckets(ourModelOutcomes, bucketWidth) },
    pureElo: { brierScore: computeBrierScore(pureEloOutcomes), calibration: computeCalibrationBuckets(pureEloOutcomes, bucketWidth) },
    coinFlip: { brierScore: computeBrierScore(coinFlipOutcomes) },
  };
}

function formatBucketTable(label: string, buckets: CalibrationBucket[]): string {
  const lines = [`  ${label}:`, "    bucket      n   mean predicted   actual win rate"];
  for (const b of buckets) {
    const predicted = Number.isNaN(b.meanPredicted) ? "     —" : `${(b.meanPredicted * 100).toFixed(1).padStart(6)}%`;
    const actual = Number.isNaN(b.actualWinRate) ? "     —" : `${(b.actualWinRate * 100).toFixed(1).padStart(6)}%`;
    lines.push(`    ${b.label.padEnd(9)} ${String(b.n).padStart(4)}   ${predicted}          ${actual}`);
  }
  return lines.join("\n");
}

function printReport(report: BacktestReport): void {
  const seasonLabel = report.seasonRange ? `seasons ${report.seasonRange.min}-${report.seasonRange.max}` : "no seasons";
  console.log(`\nWin-probability backtest — ${report.matchupCount} final, non-bye matchups (${seasonLabel})\n`);
  console.log(`Brier score (lower is better; 0 = perfect, 0.25 = a 50/50 coin flip's baseline):`);
  console.log(`  our model (pre-game): ${report.ourModel.brierScore.toFixed(4)}`);
  console.log(`  pure Elo baseline:    ${report.pureElo.brierScore.toFixed(4)}`);
  console.log(`  coin-flip baseline:   ${report.coinFlip.brierScore.toFixed(4)}`);
  console.log(
    `\n(our model and pure Elo are expected to match pre-game — see this file's module docstring for why that's a structural fact, not a bug.)\n`,
  );
  console.log(formatBucketTable("our model calibration", report.ourModel.calibration));
  console.log();
  console.log(formatBucketTable("pure Elo calibration", report.pureElo.calibration));
  console.log();
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const resolvedSource = path.resolve(args.source);
  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`winprob:backtest: source database not found at ${resolvedSource}`);
  }

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-winprob-backtest-"));
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
        throw new Error(`winprob:backtest: stats:build against the scratch copy failed: ${buildResult.errorText ?? "(no error text)"}`);
      }

      const report = runBacktest(db, args.bucketWidth);
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
