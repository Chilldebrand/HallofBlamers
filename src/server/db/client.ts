import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

function applyPragmas(sqlite: Database.Database): void {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
}

function openDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (dir && dir !== ".") {
    fs.mkdirSync(dir, { recursive: true });
  }
  const sqlite = new Database(dbPath);
  applyPragmas(sqlite);
  return sqlite;
}

let sqliteSingleton: Database.Database | undefined;
let dbSingleton: Db | undefined;

/** Raw better-sqlite3 Database handle (lazy singleton). */
export function getSqlite(): Database.Database {
  if (!sqliteSingleton) {
    const dbPath = process.env.DATABASE_PATH ?? "./data/league.db";
    sqliteSingleton = openDatabase(dbPath);
  }
  return sqliteSingleton;
}

/** Drizzle instance over the singleton database (lazy singleton). */
export function getDb(): Db {
  if (!dbSingleton) {
    dbSingleton = drizzle(getSqlite(), { schema });
  }
  return dbSingleton;
}

/**
 * Opens a throwaway database at `dbPath` with the same pragmas as the
 * singleton. Used by tests to get an isolated DB per test file/run.
 */
export function createDb(dbPath: string): { db: Db; sqlite: Database.Database } {
  const sqlite = openDatabase(dbPath);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
