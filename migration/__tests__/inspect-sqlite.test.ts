import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";
import { inspectSqlite } from "../inspect-sqlite";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "hob-inspect-"));
  dirs.push(dir);
  return path.join(dir, "league.db");
}
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

test("inspectSqlite preserves source and reports actual counts without row contents", async () => {
  const file = fixture();
  const db = new Database(file);
  db.exec("CREATE TABLE managers (id INTEGER PRIMARY KEY, secret TEXT); INSERT INTO managers VALUES (1, 'private'), (2, 'private'); CREATE TABLE empty (id INTEGER);");
  db.close();
  const before = digest(file);
  const report = await inspectSqlite(file);
  expect(digest(file)).toBe(before);
  expect(report.tables).toEqual([{ name: "empty", rows: 0 }, { name: "managers", rows: 2 }]);
  expect(report.bytes).toBe(readFileSync(file).length);
  expect(JSON.stringify(report)).not.toContain("private");
});

test("inspectSqlite refuses a missing database rather than creating one", async () => {
  const file = fixture();
  await expect(inspectSqlite(file)).rejects.toThrow();
  expect(existsSync(file)).toBe(false);
});

test("inspectSqlite reads committed WAL rows and safely quotes table names", async () => {
  const file = fixture();
  const db = new Database(file);
  try {
    db.pragma("journal_mode = WAL");
    db.exec('CREATE TABLE "odd""name" (id INTEGER); INSERT INTO "odd""name" VALUES (1)');
    expect((await inspectSqlite(file)).tables).toEqual([{ name: 'odd"name', rows: 1 }]);
  } finally { db.close(); }
});
