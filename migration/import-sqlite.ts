import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import Database from "better-sqlite3";
import { Client } from "pg";
import { quote, tableName, tables } from "./postgres-schema";

export interface PgConnection { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
export interface ImportReport { tableCounts: Record<string, number>; rejectedRows: number; elapsedMs: number; dryRun: boolean }

async function fileHash(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export function convertValue(table: string, column: string, value: unknown): unknown {
  if (value === null) return null;
  const config = tables.find(t => t.name === table)?.columns.find(c => c.name === column);
  if (!config) throw new Error(`Unrecognized source column: ${table}.${column}`);
  if (config.columnType === "SQLiteTimestamp") return new Date(Number(value) * (("mode" in config && config.mode === "timestamp") ? 1000 : 1)).toISOString();
  if (config.columnType === "SQLiteBoolean") {
    if (value !== 0 && value !== 1) throw new Error(`Invalid boolean in ${table}.${column}`);
    return value === 1;
  }
  // pg expects JSON arrays as serialized JSON, not native JS arrays (which mean SQL arrays).
  if (config.columnType === "SQLiteTextJson") return JSON.stringify(JSON.parse(String(value)));
  return value;
}

/** Use a consistent, immutable backup. A SQLite WAL sidecar is not part of the import fingerprint. */
export async function importInto(sourcePath: string, target: PgConnection, options: { dryRun: boolean }): Promise<ImportReport> {
  const started = Date.now();
  const sourceHash = await fileHash(sourcePath);
  const sqlite = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const report: ImportReport = { tableCounts: {}, rejectedRows: 0, elapsedMs: 0, dryRun: options.dryRun };
  try {
    const sourceTables = sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name").all() as { name: string }[];
    for (const { name } of sourceTables) if (!tables.some(t => t.name === name)) throw new Error(`Unrecognized source table: ${name}`);
    await target.query("BEGIN");
    try {
      await target.query("SELECT pg_advisory_xact_lock(1690915927)");
      const marker = await target.query("SELECT source_hash FROM hob_private.import_marker");
      if (marker.rows.length && marker.rows[0].source_hash !== sourceHash) throw new Error("Target was imported from a different source");
      if (!marker.rows.length) {
        for (const table of tables) {
          const result = await target.query(`SELECT 1 FROM ${tableName(table.name)} LIMIT 1`);
          if (result.rows.length) throw new Error("Refusing unmarked nonempty target");
        }
      }
      // Foreign keys are deferred so table-name ordering cannot lose cross-table references.
      for (const { name } of sourceTables) {
        const rows = sqlite.prepare(`SELECT * FROM ${quote(name)}`).iterate();
        let count = 0;
        for (const value of rows) {
          const row = value as Record<string, unknown>;
          const keys = Object.keys(row);
          await target.query(`INSERT INTO ${tableName(name)} (${keys.map(quote).join(",")}) VALUES (${keys.map((_, i) => "$" + (i + 1)).join(",")}) ON CONFLICT DO NOTHING`, keys.map(key => convertValue(name, key, row[key])));
          count++;
        }
        report.tableCounts[name] = count;
      }
      await target.query("SET CONSTRAINTS ALL IMMEDIATE");
      if (!options.dryRun) {
        for (const table of tables) for (const column of table.columns) {
          if (!("autoIncrement" in column && column.autoIncrement)) continue;
          await target.query(`SELECT setval(pg_get_serial_sequence($1,$2), COALESCE(max(${quote(column.name)}),1), count(*)>0) FROM ${tableName(table.name)}`, [`hob_private.${table.name}`, column.name]);
        }
        await target.query("INSERT INTO hob_private.import_marker(source_hash) VALUES ($1) ON CONFLICT DO NOTHING", [sourceHash]);
      }
      await target.query(options.dryRun ? "ROLLBACK" : "COMMIT");
    } catch (error) { await target.query("ROLLBACK"); throw error; }
  } finally { sqlite.close(); }
  report.elapsedMs = Date.now() - started;
  return report;
}

export async function importSqlite(sourcePath: string, targetUrl: string, options: { dryRun: boolean }): Promise<ImportReport> {
  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  try { return await importInto(sourcePath, client, options); } finally { await client.end(); }
}
