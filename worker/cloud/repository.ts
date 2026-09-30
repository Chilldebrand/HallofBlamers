import { tables, tableName, quote } from "../../migration/postgres-schema";
import { convertValue, type PgConnection } from "../../migration/import-sqlite";
import type { DataSet, Row } from "./workspace";

export const DERIVED_TABLES = ["team_week", "allplay_week", "elo_history", "franchise_elo", "belt_matches", "belt_reigns", "record_entries", "h2h_pairs", "career_stats", "season_stats", "context_notes", "achievements", "slot_scoring_stats", "playoff_odds"];
export const SEASON_TABLES = ["team_seasons", "weeks", "matchups", "roster_slots", "transactions", "draft_picks"];
const INPUT_TABLES = ["leagues", "seasons", "franchises", "franchise_managers", "players", "corrections", ...SEASON_TABLES, "transaction_items", "app_settings", "stat_builds", "events", "snapshots"];
export const LOCK_KEY = 1690915927;

export async function loadInputs(pg: PgConnection, season: number) {
  const input: DataSet = {};
  const maxima: Record<string, number> = {};
  await pg.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await pg.query("SET LOCAL extra_float_digits=3");
    for (const name of INPUT_TABLES) {
      let suffix = "";
      let values: unknown[] = [];
      if (["transactions", "draft_picks", "events"].includes(name)) { suffix = " WHERE season=$1"; values = [season]; }
      if (name === "transaction_items") { suffix = " WHERE transaction_id IN (SELECT id FROM hob_private.transactions WHERE season=$1)"; values = [season]; }
      if (name === "app_settings") suffix = " WHERE key IN ('espn_league_id','belt_overrides')";
      if (name === "stat_builds") suffix = " ORDER BY id DESC LIMIT 1";
      const snapshotColumns = tables.find(t => t.name === "snapshots")!.columns.map(c => c.name === "payload" ? "COALESCE(c.payload,s.payload) AS payload" : `s.${quote(c.name)}`).join(",");
      const sql = name === "snapshots" ? `SELECT DISTINCT ON (s.view,s.scoring_period) ${snapshotColumns} FROM hob_private.snapshots s LEFT JOIN hob_private.cloud_snapshot_cache c ON c.snapshot_id=s.id AND c.version=1 WHERE s.season=$1 AND NOT s.superseded ORDER BY s.view,s.scoring_period,s.fetched_at DESC,s.id DESC` : `SELECT * FROM ${tableName(name)}${suffix}`;
      input[name] = (await pg.query(sql, name === "snapshots" ? [season] : values)).rows;
      if (tables.find(t => t.name === name)?.columns.some(c => "autoIncrement" in c && c.autoIncrement)) {
        maxima[name] = Number((await pg.query(`SELECT COALESCE(max(id),0) AS maximum FROM ${tableName(name)}`)).rows[0].maximum);
      }
    }
    await pg.query("COMMIT");
  } catch (error) { await pg.query("ROLLBACK"); throw error; }
  return { input, maxima, inputBytes: Buffer.byteLength(JSON.stringify(input)) };
}

async function upsertRows(pg: PgConnection, table: string, rows: Row[]) {
  if (!rows.length) return;
  const config = tables.find(t => t.name === table);
  if (!config) throw new Error("Unknown publication table");
  const keys = Object.keys(rows[0]);
  const primary = config.columns.filter(c => c.primary).map(c => c.name);
  if (!primary.length) primary.push(...config.primaryKeys.flatMap(k => k.columns.map(c => c.name)));
  const conflict = table === "events" ? ["dedupe_key"] : primary;
  const update = keys.filter(k => !conflict.includes(k)).map(k => `${quote(k)}=EXCLUDED.${quote(k)}`).join(",");
  const onConflict = table === "events" ? "DO NOTHING" : `DO UPDATE SET ${update}`;
  for (let offset = 0; offset < rows.length; offset += 100) {
    const chunk = rows.slice(offset, offset + 100);
    const values = chunk.flatMap(row => keys.map(key => convertValue(table, key, row[key])));
    const params = chunk.map((_, row) => `(${keys.map((_, col) => `$${row * keys.length + col + 1}`).join(",")})`).join(",");
    await pg.query(`INSERT INTO ${tableName(table)} (${keys.map(quote)}) VALUES ${params} ON CONFLICT (${conflict.map(quote)}) ${onConflict}`, values);
  }
}

export async function publishGeneration(pg: PgConnection, publication: { season: number; rows: DataSet; runId: number; viewsFetched: number; snapshotsNew: number }) {
  const { rows, season, runId } = publication;
  if (DERIVED_TABLES.some(t => !Array.isArray(rows[t])) || rows.stat_builds?.length !== 1 || rows.stat_builds[0].status !== "ok") throw new Error("Incomplete derived generation");
  await pg.query("BEGIN");
  try {
    await pg.query("SET LOCAL statement_timeout='120s'");
    for (const table of DERIVED_TABLES) await pg.query(`DELETE FROM ${tableName(table)}`);
    // A complete season projection is swapped in the same transaction as its stats.
    if (rows.team_seasons) {
      await pg.query("DELETE FROM hob_private.transaction_items WHERE transaction_id IN (SELECT id FROM hob_private.transactions WHERE season=$1)", [season]);
      for (const table of [...SEASON_TABLES].reverse()) await pg.query(`DELETE FROM ${tableName(table)} WHERE season=$1`, [season]);
    }
    for (const table of ["leagues", "seasons", "players", ...SEASON_TABLES, "transaction_items", "stat_builds", ...DERIVED_TABLES, "snapshots", "events"]) {
      await upsertRows(pg, table, rows[table] ?? []);
      const config = tables.find(t => t.name === table);
      if (rows[table]?.length && config?.columns.some(c => "autoIncrement" in c && c.autoIncrement)) {
        await pg.query(`SELECT setval(pg_get_serial_sequence($1,'id'),COALESCE(max(id),1),count(*)>0) FROM ${tableName(table)}`, [`hob_private.${table}`]);
      }
    }
    for (const row of rows.cloud_snapshot_cache ?? []) await pg.query("INSERT INTO hob_private.cloud_snapshot_cache(snapshot_id,version,payload) VALUES($1,1,$2) ON CONFLICT(snapshot_id) DO UPDATE SET version=1,payload=EXCLUDED.payload", [row.snapshot_id, row.payload]);
    await pg.query("UPDATE hob_private.sync_runs SET status='ok',finished_at=now(),views_fetched=$2,snapshots_new=$3,events_emitted=$4,error_text=NULL WHERE id=$1", [runId, publication.viewsFetched, publication.snapshotsNew, rows.events?.length ?? 0]);
    await pg.query("SET CONSTRAINTS ALL IMMEDIATE");
    await pg.query("COMMIT");
  } catch (error) { await pg.query("ROLLBACK"); throw error; }
}
