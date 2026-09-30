import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { Client } from "pg";
import { convertValue, type PgConnection } from "./import-sqlite";
import { quote, tableName, tables } from "./postgres-schema";

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
const hashRow = (row: Record<string, unknown>) => createHash("sha256").update(JSON.stringify(canonical(row))).digest("hex");

export async function reconcileInto(sourcePath: string, target: PgConnection): Promise<{ passed: boolean; mismatches: string[]; databaseBytes: number }> {
  const sqlite = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const mismatches: string[] = [];
  let originalFloatDigits: string | undefined;
  try {
    // Hosted Postgres may default to rounded float text. Compare exact stored
    // IEEE-754 values rather than introducing a tolerance that hides drift.
    const setting = await target.query("SELECT current_setting('extra_float_digits') AS value");
    originalFloatDigits = String(setting.rows[0].value);
    await target.query("SET extra_float_digits=3");
    const sourceTables = sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name").all() as { name: string }[];
    for (const { name } of sourceTables) {
      const config = tables.find(t => t.name === name);
      if (!config) { mismatches.push(`${name}: unknown source table`); continue; }
      const raw = sqlite.prepare(`SELECT * FROM ${quote(name)}`).all() as Record<string, unknown>[];
      const sourceHashes = raw.map(row => hashRow(Object.fromEntries(Object.entries(row).map(([key, value]) => {
        const converted = convertValue(name, key, value);
        return [key, config.columns.find(c => c.name === key)?.columnType === "SQLiteTextJson" && converted !== null ? JSON.parse(String(converted)) : converted];
      })))).sort();
      const keys = (sqlite.prepare(`PRAGMA table_info(${quote(name)})`).all() as { name: string }[]).map(c => c.name);
      const rows = (await target.query(`SELECT ${keys.map(quote).join(",")} FROM ${tableName(name)}`)).rows;
      if (rows.length !== raw.length) mismatches.push(`${name}: row count differs`);
      else if (JSON.stringify(sourceHashes) !== JSON.stringify(rows.map(hashRow).sort())) mismatches.push(`${name}: content differs`);
    }
    const size = await target.query("SELECT pg_database_size(current_database())::text AS bytes");
    return { passed: mismatches.length === 0, mismatches, databaseBytes: Number(size.rows[0].bytes) };
  } finally {
    sqlite.close();
    if (originalFloatDigits !== undefined) await target.query("SELECT set_config('extra_float_digits',$1,false)", [originalFloatDigits]);
  }
}

export async function reconcile(sourcePath: string, targetUrl: string) {
  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  try { return await reconcileInto(sourcePath, client); } finally { await client.end(); }
}
