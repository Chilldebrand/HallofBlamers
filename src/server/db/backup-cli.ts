/**
 * Backup CLI: `npm run backup`. Runs one on-demand backup of
 * `DATABASE_PATH` into `<its directory>/backups/`, same `runBackup` logic
 * the worker's nightly cron job calls — this is what `ops/backup-now.sh`
 * invokes inside the `web` container (`docker compose exec web npm run
 * backup`) for an ad-hoc backup between scheduled runs.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getSqlite } from "./client";
import { runBackup } from "./backup";

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

export async function main(): Promise<void> {
  const dbPath = process.env.DATABASE_PATH ?? "./data/league.db";
  const backupDir = path.join(path.dirname(dbPath), "backups");

  const sqlite = getSqlite();
  const result = runBackup(sqlite, backupDir);

  console.log(`Backup written: ${result.path} (${result.bytesWritten.toLocaleString()} bytes)`);
  if (result.pruned.length > 0) {
    console.log(`Pruned ${result.pruned.length} old backup(s): ${result.pruned.join(", ")}`);
  }
}

if (isMainModule()) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
