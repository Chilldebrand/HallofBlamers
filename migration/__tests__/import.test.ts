import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";
import { generateSchema } from "../postgres-schema";
import { importInto } from "../import-sqlite";
import { reconcileInto } from "../reconcile";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(invalid = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "hob-import-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "source.db");
  const sqlite = new Database(file);
  sqlite.exec(`CREATE TABLE leagues (id INTEGER PRIMARY KEY, espn_league_id INTEGER, name TEXT, first_season INTEGER);
    INSERT INTO leagues VALUES (7,1690915927,'Fixture',2020);
    CREATE TABLE seasons (season INTEGER PRIMARY KEY,league_id INTEGER,settings_json TEXT,scoring_json TEXT,playoff_format_json TEXT,team_count INTEGER,reg_season_weeks INTEGER,status TEXT);
    INSERT INTO seasons VALUES (2020,${invalid ? 999 : 7},'{}','{}','{}',12,14,'complete');`);
  sqlite.close();
  const pg = new PGlite();
  cleanups.push(() => pg.close());
  await pg.exec(generateSchema());
  return { file, pg };
}

test("repeat import preserves IDs and counts, advances identity, and reconciles", async () => {
  const { file, pg } = await setup();
  await importInto(file, pg, { dryRun: false });
  await importInto(file, pg, { dryRun: false });
  expect((await pg.query("select id from hob_private.leagues")).rows).toEqual([{ id: 7 }]);
  expect((await reconcileInto(file, pg)).passed).toBe(true);
  const next = await pg.query("insert into hob_private.leagues(espn_league_id,name,first_season) values(2,'Other',2021) returning id");
  expect(next.rows).toEqual([{ id: 8 }]);
}, 30000);

test("invalid foreign key rolls back every imported row", async () => {
  const { file, pg } = await setup(true);
  await expect(importInto(file, pg, { dryRun: false })).rejects.toThrow();
  expect((await pg.query("select count(*)::int as n from hob_private.leagues")).rows).toEqual([{ n: 0 }]);
}, 30000);

test("reconcile detects changed values even when row counts match", async () => {
  const { file, pg } = await setup();
  await importInto(file, pg, { dryRun: false });
  await pg.query("update hob_private.seasons set team_count=10 where season=2020");
  const result = await reconcileInto(file, pg);
  expect(result.passed).toBe(false);
  expect(result.mismatches).toContain("seasons: content differs");
}, 30000);

test("reconcile preserves exact floats when the server defaults to rounded text output", async () => {
  const { file, pg } = await setup();
  await importInto(file, pg, { dryRun: false });
  const sqlite = new Database(file);
  sqlite.exec('CREATE TABLE franchise_elo (id INTEGER PRIMARY KEY, current REAL)');
  sqlite.prepare('INSERT INTO franchise_elo VALUES (1,?)').run(0.1 + 0.2);
  sqlite.close();
  await pg.query("INSERT INTO hob_private.stat_builds(id,started_at,input_hash,status) VALUES(1,now(),'fixture','ok')");
  await pg.query('INSERT INTO hob_private.franchise_elo(id,build_id,franchise_id,current,peak,peak_season,peak_week,trough,weeks_at_no1) VALUES(1,1,1,$1,1,2020,1,0,0)', [0.1 + 0.2]);
  await pg.query('SET extra_float_digits=0');
  expect((await reconcileInto(file, pg)).passed).toBe(true);
  expect((await pg.query("SHOW extra_float_digits")).rows).toEqual([{ extra_float_digits: "0" }]);
  await pg.query('UPDATE hob_private.franchise_elo SET current=0.3 WHERE id=1');
  expect((await reconcileInto(file, pg)).passed).toBe(false);
}, 30000);

test("dry run validates constraints but leaves no imported rows", async () => {
  const { file, pg } = await setup();
  await importInto(file, pg, { dryRun: true });
  expect((await pg.query("select count(*)::int as n from hob_private.leagues")).rows).toEqual([{ n: 0 }]);
}, 30000);

test("import refuses an unmarked populated target", async () => {
  const { file, pg } = await setup();
  await pg.query("insert into hob_private.leagues(id,espn_league_id,name,first_season) values(9,99,'Existing',2020)");
  await expect(importInto(file, pg, { dryRun: false })).rejects.toThrow("nonempty");
}, 30000);

test("all application tables start with RLS enabled and no public schema exposure", async () => {
  const { pg } = await setup();
  const tables = await pg.query("select relname from pg_class c join pg_namespace n on c.relnamespace=n.oid where n.nspname='hob_private' and c.relkind='r' and not c.relrowsecurity");
  expect(tables.rows).toEqual([]);
  expect((await pg.query("select count(*)::int as n from pg_tables where schemaname='public'")).rows).toEqual([{ n: 0 }]);
}, 30000);
