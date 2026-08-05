/**
 * Manual corrections — the third input to the normalizer's pure function
 * (`raw snapshots + seed files + corrections -> normalized tables`, see
 * AGENTS.md). Corrections are hand-authored fixes for known-bad ESPN data
 * (a misreported score, a player mis-slotted, etc), applied LAST, after a
 * season's tables are rebuilt from scratch, so they survive every re-run.
 */
import fs from "node:fs";
import path from "node:path";
import { and, eq, getTableColumns, type Column } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  corrections,
  draftPicks,
  franchiseManagers,
  franchises,
  leagues,
  matchups,
  players,
  rosterSlots,
  seasons,
  teamSeasons,
  transactionItems,
  transactions,
  weeks,
} from "../db/schema";
import { stableStringify } from "./parse-utils";

// Only layer-2 (normalized) tables may be corrected — never snapshots, and
// never layer-3 operational tables (events, sync_runs, app_settings, ...).
type CorrectableTable =
  | typeof leagues
  | typeof seasons
  | typeof franchises
  | typeof franchiseManagers
  | typeof teamSeasons
  | typeof weeks
  | typeof matchups
  | typeof players
  | typeof rosterSlots
  | typeof transactions
  | typeof transactionItems
  | typeof draftPicks;

const ALLOWED_TABLES: Record<string, CorrectableTable> = {
  leagues,
  seasons,
  franchises,
  franchise_managers: franchiseManagers,
  team_seasons: teamSeasons,
  weeks,
  matchups,
  players,
  roster_slots: rosterSlots,
  transactions,
  transaction_items: transactionItems,
  draft_picks: draftPicks,
};

interface ColumnRef {
  /** The JS/Drizzle property name — what `.set()`/insert objects must be keyed by. */
  jsName: string;
  column: Column;
}

/** Maps a table's DB (snake_case) column names to `{jsName, column}`, for dynamic access by DB name. */
function columnsByDbName(table: CorrectableTable): Record<string, ColumnRef> {
  const out: Record<string, ColumnRef> = {};
  for (const [jsName, column] of Object.entries(getTableColumns(table))) {
    out[column.name] = { jsName, column };
  }
  return out;
}

/**
 * Coerces a correction's raw JSON value (a plain number/string/etc — JSON has
 * no Date type) into whatever shape the target column's Drizzle mode
 * actually wants to write. Only `timestamp_ms` columns (`dataType ===
 * "date"`, e.g. `transactions.proposed_at`/`processed_at`) need this: the
 * better-sqlite3 driver calls `.getTime()` on the value it's handed, which
 * throws for a bare number/string. Any other column mode passes through
 * unchanged (booleans and JSON columns already round-trip through Drizzle
 * without help). Throws (caught by the caller) rather than silently writing
 * an `Invalid Date` when the value can't be turned into a real timestamp.
 */
function coerceValueForColumn(column: Column, value: unknown): unknown {
  const dataType = (column as unknown as { dataType?: string }).dataType;
  if (dataType !== "date") return value;
  if (value instanceof Date) return value;

  let date: Date | undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    date = new Date(value);
  } else if (typeof value === "string" && value.trim() !== "") {
    const asNumber = Number(value);
    date = Number.isFinite(asNumber) ? new Date(asNumber) : new Date(value);
  }

  if (!date || Number.isNaN(date.getTime())) {
    throw new Error(`value ${JSON.stringify(value)} is not a valid timestamp for column "${column.name}"`);
  }
  return date;
}

// ---------------------------------------------------------------------------
// loadSeedCorrections — reads seed/corrections/*.json into the DB
// ---------------------------------------------------------------------------

export interface RawCorrectionSeed {
  targetTable: string;
  targetKey: Record<string, unknown>;
  field: string;
  value: unknown;
  reason: string;
  createdBy: string;
  active?: boolean;
}

function defaultCorrectionsDir(): string {
  return path.join(process.cwd(), "seed", "corrections");
}

function isValidRawCorrection(entry: unknown): entry is RawCorrectionSeed {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.targetTable === "string" &&
    e.targetKey !== null &&
    typeof e.targetKey === "object" &&
    !Array.isArray(e.targetKey) &&
    typeof e.field === "string" &&
    "value" in e &&
    typeof e.reason === "string" &&
    typeof e.createdBy === "string"
  );
}

export interface LoadCorrectionsResult {
  loaded: number;
  warnings: string[];
}

/**
 * Reads every `seed/corrections/*.json` file (each a JSON array of
 * correction objects; `*.example.json` files are ignored) and upserts them
 * into the `corrections` table. Idempotent: keyed on
 * `(target_table, target_key_json, field)` — a re-run with the same seed
 * files updates the existing row in place rather than duplicating it.
 */
export function loadSeedCorrections(db: Db, seedDir: string = defaultCorrectionsDir()): LoadCorrectionsResult {
  const warnings: string[] = [];
  let loaded = 0;

  if (!fs.existsSync(seedDir)) {
    return { loaded, warnings };
  }

  const files = fs
    .readdirSync(seedDir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".example.json"))
    .sort();

  for (const file of files) {
    const filePath = path.join(seedDir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
      warnings.push(`${file}: not valid JSON, skipped (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (!Array.isArray(raw)) {
      warnings.push(`${file}: expected a top-level JSON array of correction objects, skipped`);
      continue;
    }

    for (const [index, entry] of raw.entries()) {
      if (!isValidRawCorrection(entry)) {
        warnings.push(`${file}[${index}]: missing required targetTable/targetKey/field/value/reason/createdBy, skipped`);
        continue;
      }
      upsertCorrection(db, entry);
      loaded++;
    }
  }

  return { loaded, warnings };
}

function upsertCorrection(db: Db, entry: RawCorrectionSeed): void {
  const canonicalKey = stableStringify(entry.targetKey);
  const active = entry.active ?? true;

  const candidates = db
    .select()
    .from(corrections)
    .where(and(eq(corrections.targetTable, entry.targetTable), eq(corrections.field, entry.field)))
    .all();

  const existing = candidates.find((row) => stableStringify(row.targetKeyJson) === canonicalKey);

  if (existing) {
    db.update(corrections)
      .set({
        targetKeyJson: entry.targetKey,
        valueJson: entry.value,
        reason: entry.reason,
        createdBy: entry.createdBy,
        active,
      })
      .where(eq(corrections.id, existing.id))
      .run();
  } else {
    db.insert(corrections)
      .values({
        targetTable: entry.targetTable,
        targetKeyJson: entry.targetKey,
        field: entry.field,
        valueJson: entry.value,
        reason: entry.reason,
        createdBy: entry.createdBy,
        active,
      })
      .run();
  }
}

// ---------------------------------------------------------------------------
// applyCorrections — applies active corrections rows to a season's tables
// ---------------------------------------------------------------------------

export interface ApplyCorrectionsResult {
  applied: number;
  warnings: string[];
}

/**
 * Applies every active correction to the given season's freshly-rebuilt
 * layer-2 rows. A correction whose `target_key_json` includes a `season`
 * field only applies when it matches the season being normalized; a
 * correction with no `season` key in its target key (targeting a global
 * table row, e.g. `players`) applies every time this runs — harmless, since
 * setting the same field to the same value repeatedly is idempotent.
 * Unknown tables/columns or a target row that can't be found are warnings,
 * never a crash — a bad correction shouldn't take down the whole rebuild.
 */
export function applyCorrections(db: Db, season: number): ApplyCorrectionsResult {
  const warnings: string[] = [];
  let applied = 0;

  const active = db.select().from(corrections).where(eq(corrections.active, true)).all();

  for (const correction of active) {
    const targetKey = correction.targetKeyJson;
    if (!targetKey || typeof targetKey !== "object" || Array.isArray(targetKey)) {
      warnings.push(`correction #${correction.id}: target_key_json is not an object, skipped`);
      continue;
    }
    const keyObj = targetKey as Record<string, unknown>;
    if ("season" in keyObj && keyObj.season !== season) {
      continue; // scoped to a different season — not an error, just not applicable here
    }

    const table = ALLOWED_TABLES[correction.targetTable];
    if (!table) {
      warnings.push(
        `correction #${correction.id}: target_table "${correction.targetTable}" is not an allowed layer-2 table, skipped`,
      );
      continue;
    }

    const columns = columnsByDbName(table);
    const fieldColumn = columns[correction.field];
    if (!fieldColumn) {
      warnings.push(
        `correction #${correction.id}: field "${correction.field}" is not a column of "${correction.targetTable}", skipped`,
      );
      continue;
    }

    let keyOk = true;
    try {
      const whereConditions = [];
      for (const [keyName, keyValue] of Object.entries(keyObj)) {
        const keyColumn = columns[keyName];
        if (!keyColumn) {
          warnings.push(
            `correction #${correction.id}: target_key_json field "${keyName}" is not a column of "${correction.targetTable}", skipped`,
          );
          keyOk = false;
          break;
        }
        whereConditions.push(eq(keyColumn.column, coerceValueForColumn(keyColumn.column, keyValue)));
      }
      if (!keyOk) continue;
      if (whereConditions.length === 0) {
        warnings.push(`correction #${correction.id}: target_key_json is empty, skipped`);
        continue;
      }

      const result = db
        .update(table)
        .set({ [fieldColumn.jsName]: coerceValueForColumn(fieldColumn.column, correction.valueJson) } as never)
        .where(and(...whereConditions))
        .run();

      if (result.changes === 0) {
        warnings.push(
          `correction #${correction.id}: no row in "${correction.targetTable}" matched target_key_json ${stableStringify(keyObj)}, skipped`,
        );
        continue;
      }

      applied++;
    } catch (err) {
      // Never let one bad correction crash the whole rebuild — see module docstring.
      warnings.push(
        `correction #${correction.id}: failed to apply (${err instanceof Error ? err.message : String(err)}), skipped`,
      );
    }
  }

  return { applied, warnings };
}
