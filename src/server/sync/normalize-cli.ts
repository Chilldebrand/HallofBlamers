/**
 * Normalizer CLI: `npm run normalize -- [--season 2024]`.
 *
 * Runs migrations, loads the franchise + corrections seed files, then
 * validates + normalizes either one season or every season with an archived
 * snapshot, printing a per-season summary table and any warnings.
 */
import { pathToFileURL } from "node:url";
import { runMigrations } from "../db/migrate";
import { getDb } from "../db/client";
import { loadSeedCorrections } from "./corrections";
import { loadFranchiseSeed } from "./franchise-map";
import { normalizeAll, normalizeSeason, type NormalizeSummary } from "./normalize";

export interface CliArgs {
  season?: number;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  let season: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--season":
        season = Number(argv[++i]);
        if (Number.isNaN(season)) {
          throw new Error("normalize: --season must be a number, e.g. --season 2024");
        }
        break;
      default:
        throw new Error(`normalize: unknown argument "${arg}"`);
    }
  }

  return { season };
}

function printSummaryTable(summaries: NormalizeSummary[]): void {
  const tableNames = [...new Set(summaries.flatMap((s) => Object.keys(s.written)))].sort();

  console.log("\nseason | " + (tableNames.length > 0 ? tableNames.join(" | ") : "(nothing written)"));
  for (const s of summaries) {
    const skipped = Object.keys(s.written).length === 0;
    const cells = tableNames.map((t) => String(s.written[t] ?? (skipped ? "SKIPPED" : 0)));
    console.log(`${s.season}  | ${cells.join(" | ")}`);
  }

  const warned = summaries.filter((s) => s.warnings.length > 0);
  if (warned.length > 0) {
    console.log("\nWarnings:");
    for (const s of warned) {
      console.log(`\n-- season ${s.season} --`);
      for (const w of s.warnings) console.log(w);
    }
  }
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const db = getDb();
  runMigrations(db);

  const { seed: franchiseSeed, warnings: franchiseWarnings } = loadFranchiseSeed();
  for (const w of franchiseWarnings) console.log(`[seed] ${w}`);

  const correctionsResult = loadSeedCorrections(db);
  console.log(`[seed] loaded ${correctionsResult.loaded} correction(s)`);
  for (const w of correctionsResult.warnings) console.log(`[seed] ${w}`);

  const summaries =
    args.season !== undefined
      ? [normalizeSeason(db, args.season, { franchiseSeed })]
      : normalizeAll(db, { franchiseSeed });

  printSummaryTable(summaries);

  const anySkipped = summaries.some((s) => Object.keys(s.written).length === 0);
  if (anySkipped) {
    process.exitCode = 1;
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
