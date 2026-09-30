import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { PgConnection } from "./import-sqlite";

export async function applyMigrations(db: PgConnection & { exec?: (sql: string) => Promise<unknown> }, directory: string): Promise<string[]> {
  // PGlite query uses the extended protocol; exec is its multi-statement API.
  // node-postgres query without parameters uses the simple protocol.
  const execute = (sql: string) => db.exec ? db.exec(sql) : db.query(sql);
  await execute(`CREATE SCHEMA IF NOT EXISTS hob_migration_meta;
    REVOKE ALL ON SCHEMA hob_migration_meta FROM PUBLIC;
    CREATE TABLE IF NOT EXISTS hob_migration_meta.applied(name text PRIMARY KEY, digest text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE hob_migration_meta.applied ENABLE ROW LEVEL SECURITY;`);
  const applied: string[] = [];
  for (const name of (await readdir(directory)).filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
    const sql = await readFile(path.join(directory, name), "utf8");
    const digest = createHash("sha256").update(sql).digest("hex");
    await db.query("BEGIN");
    try {
      await db.query("select pg_advisory_xact_lock(1690915926)");
      const prior = await db.query("select digest from hob_migration_meta.applied where name=$1", [name]);
      if (prior.rows.length) {
        if (prior.rows[0].digest !== digest) throw new Error(`Applied migration changed: ${name}`);
      } else {
        await execute(sql);
        await db.query("insert into hob_migration_meta.applied(name,digest) values($1,$2)", [name, digest]);
        applied.push(name);
      }
      await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK"); throw error; }
  }
  return applied;
}
