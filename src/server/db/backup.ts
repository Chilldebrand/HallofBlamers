/**
 * Nightly backup (Task 15): `VACUUM INTO` a dated snapshot of the live
 * database into `data/backups/`, then prune down to the newest N. `VACUUM
 * INTO` reads a consistent snapshot of a WAL-mode database without blocking
 * concurrent readers/writers (see SQLite docs), so this is safe to run
 * against the live, in-use `sqlite` handle while `web`/`worker` keep serving
 * traffic — this module never opens `data/league.db` itself; callers pass
 * the already-open handle in.
 */
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

/** How many nightly backups to keep on disk — oldest beyond this are pruned. */
export const BACKUP_RETENTION_COUNT = 14;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `league-YYYY-MM-DD.db`, UTC date — the brief's `league-<date>.db` naming, lexicographically
 * sortable so `pruneOldBackups` can find "oldest" by a plain string sort. */
export function backupFileName(now: Date): string {
  return `league-${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}.db`;
}

const BACKUP_FILE_NAME_RE = /^league-\d{4}-\d{2}-\d{2}\.db$/;

/**
 * Deletes the oldest `league-YYYY-MM-DD.db` files in `dir` beyond the newest
 * `retain`, by filename sort (== chronological order for this naming).
 * Anything in `dir` NOT matching that exact pattern (a manually-named backup,
 * a stray file) is left alone — pruning only ever touches files it itself
 * could have produced. Returns the deleted file names.
 */
export function pruneOldBackups(dir: string, retain: number): string[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => BACKUP_FILE_NAME_RE.test(f))
    .sort();
  const toDelete = files.length > retain ? files.slice(0, files.length - retain) : [];
  for (const f of toDelete) fs.rmSync(path.join(dir, f));
  return toDelete;
}

export interface RunBackupResult {
  path: string;
  bytesWritten: number;
  /** File names deleted by the retention prune this call triggered. */
  pruned: string[];
}

/**
 * Runs one backup: `VACUUM INTO` today's dated file in `backupDir` (creating
 * the directory if needed), then prunes to `BACKUP_RETENTION_COUNT`. If a
 * same-day file already exists (e.g. a manual `backup-now.sh` run right
 * after the nightly job already ran), it's removed first — `VACUUM INTO`
 * refuses to overwrite an existing file, and "run again today" should mean
 * "replace today's backup," not fail.
 */
export function runBackup(sqlite: Database.Database, backupDir: string, now: Date = new Date()): RunBackupResult {
  fs.mkdirSync(backupDir, { recursive: true });
  const fileName = backupFileName(now);
  const filePath = path.join(backupDir, fileName);

  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath);
  }

  sqlite.prepare("VACUUM INTO ?").run(filePath);

  const pruned = pruneOldBackups(backupDir, BACKUP_RETENTION_COUNT);
  const bytesWritten = fs.statSync(filePath).size;

  return { path: filePath, bytesWritten, pruned };
}
