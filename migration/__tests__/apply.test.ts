import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";
import { applyMigrations } from "../apply";

test("applies each migration once and rejects changed history", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hob-sql-"));
  const db = new PGlite();
  try {
    const file = path.join(dir, "001.sql");
    writeFileSync(file, "CREATE TABLE sample(id integer primary key); INSERT INTO sample VALUES(1);");
    expect(await applyMigrations(db, dir)).toEqual(["001.sql"]);
    expect(await applyMigrations(db, dir)).toEqual([]);
    writeFileSync(file, "CREATE TABLE changed(id integer);");
    await expect(applyMigrations(db, dir)).rejects.toThrow("changed");
    expect((await db.query("select * from sample")).rows).toEqual([{ id: 1 }]);
  } finally { await db.close(); rmSync(dir, { recursive: true, force: true }); }
}, 30000);

test("failed migration rolls back its DDL and does not mark it applied", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hob-sql-"));
  const db = new PGlite();
  try {
    writeFileSync(path.join(dir, "001.sql"), "CREATE TABLE sample(id integer); SELECT missing_function();");
    await expect(applyMigrations(db, dir)).rejects.toThrow();
    expect((await db.query("select to_regclass('public.sample') as table_name")).rows).toEqual([{ table_name: null }]);
    expect((await db.query("select count(*)::int as n from hob_migration_meta.applied")).rows).toEqual([{ n: 0 }]);
  } finally { await db.close(); rmSync(dir, { recursive: true, force: true }); }
}, 30000);
