/**
 * Stat build CLI: `npm run stats:build -- [--force]`.
 *
 * Runs migrations, then a full stat rebuild (`runStatBuild`), printing a
 * summary: build id, duration, row counts, warnings, and whether the build
 * was skipped because nothing changed since the last successful build.
 */
import { pathToFileURL } from "node:url";
import { getDb } from "../db/client";
import { runMigrations } from "../db/migrate";
import { runStatBuild, type BuildResult } from "./build";

export interface CliArgs {
  force?: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  let force: boolean | undefined;

  for (const arg of argv) {
    switch (arg) {
      case "--force":
        force = true;
        break;
      default:
        throw new Error(`stats:build: unknown argument "${arg}"`);
    }
  }

  return { force };
}

function printSummary(result: BuildResult): void {
  console.log(`\nstat build: ${result.status}`);
  console.log(`  build id: ${result.buildId ?? "(none)"}`);
  if (result.durationMs !== null) console.log(`  duration: ${result.durationMs}ms`);
  if (result.status !== "skipped") {
    console.log(`  team_week rows: ${result.rowCounts.teamWeek}`);
    console.log(`  allplay_week rows: ${result.rowCounts.allplayWeek}`);
  } else {
    console.log(`  input unchanged since the last successful build — skipped`);
  }

  if (result.warnings.length > 0) {
    console.log(`\nWarnings (${result.warnings.length}):`);
    for (const w of result.warnings) console.log(`  - ${w}`);
  }

  if (result.status === "failed") {
    console.error(`\nBuild failed: ${result.errorText ?? "(no error text)"}`);
  }
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const db = getDb();
  runMigrations(db);

  const result = runStatBuild(db, { force: args.force });
  printSummary(result);

  if (result.status === "failed") {
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
