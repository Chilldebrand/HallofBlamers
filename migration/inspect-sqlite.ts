import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

export interface SqliteInspection {
  bytes: number;
  tables: { name: string; rows: number }[];
}

/** Counts only: credentials and row contents must never enter the report. */
export async function inspectSqlite(sourcePath: string): Promise<SqliteInspection> {
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    const tables = db.transaction(() => {
      const names = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
      return names.map(({ name }) => {
        const identifier = '"' + name.replaceAll('"', '""') + '"';
        const row = db.prepare(`SELECT count(*) AS rows FROM ${identifier}`).get() as { rows: number };
        return { name, rows: row.rows };
      });
    })();
    return { bytes: (await stat(sourcePath)).size, tables };
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const sourcePath = process.argv[2];
  if (!sourcePath) throw new Error("Usage: tsx migration/inspect-sqlite.ts <database-path>");
  inspectSqlite(sourcePath).then(report => console.log(JSON.stringify(report, null, 2))).catch(() => {
    console.error("Database inspection failed. Verify the source path and database integrity.");
    process.exitCode = 1;
  });
}
