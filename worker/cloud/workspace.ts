import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../src/server/db/schema";
import { runMigrations } from "../../src/server/db/migrate";
import { tables, quote } from "../../migration/postgres-schema";
import type { FranchiseSeed } from "../../src/server/sync/franchise-map";
import { WEEK_SCOPE_VIEW_KEY, type EspnWeekScopePayload } from "../../src/server/sync/espn-shapes";

export type Row = Record<string, unknown>;
export type DataSet = Record<string, Row[]>;

export function compactSnapshotPayload(view: string, payload: string): string {
  if (view !== WEEK_SCOPE_VIEW_KEY) return payload;
  const json = JSON.parse(payload) as EspnWeekScopePayload;
  return JSON.stringify({ schedule: json.schedule?.map(entry => ({
    id: entry.id, matchupPeriodId: entry.matchupPeriodId, playoffTierType: entry.playoffTierType, winner: entry.winner,
    ...Object.fromEntries((["home", "away"] as const).map(key => {
      const side = entry[key];
      return [key, side ? { teamId: side.teamId, rosterForCurrentScoringPeriod: { entries: side.rosterForCurrentScoringPeriod?.entries?.map(r => {
        const p = r.playerPoolEntry?.player;
        return { lineupSlotId: r.lineupSlotId, playerPoolEntry: { id: r.playerPoolEntry?.id, appliedStatTotal: r.playerPoolEntry?.appliedStatTotal,
          player: p ? { id: p.id, fullName: p.fullName, defaultPositionId: p.defaultPositionId, eligibleSlots: p.eligibleSlots, proTeamId: p.proTeamId, injuryStatus: p.injuryStatus,
            stats: p.stats?.map(s => ({ scoringPeriodId: s.scoringPeriodId, statSourceId: s.statSourceId, appliedTotal: s.appliedTotal })) } : undefined } };
      }) } } : undefined];
    })),
  })) });
}

export function toSqliteValue(table: string, key: string, value: unknown): unknown {
  if (value === null) return null;
  const col = tables.find(t => t.name === table)?.columns.find(c => c.name === key);
  if (!col) throw new Error(`Unknown computation field ${table}.${key}`);
  if (col.columnType === "SQLiteTimestamp") return new Date(value as string | Date).getTime() / (("mode" in col && col.mode === "timestamp") ? 1000 : 1);
  if (col.columnType === "SQLiteBoolean") return value ? 1 : 0;
  if (col.columnType === "SQLiteTextJson") return JSON.stringify(value);
  return value;
}

/** Ephemeral compute workspace, never a persisted database or source of truth. */
export function createWorkspace(input: DataSet, maxima: Record<string, number>) {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  try {
    runMigrations(db);
    sqlite.pragma("foreign_keys=OFF");
    sqlite.transaction(() => {
      for (const [table, rows] of Object.entries(input)) {
        if (!rows.length) continue;
        const keys = Object.keys(rows[0]);
        const stmt = sqlite.prepare(`INSERT INTO ${quote(table)} (${keys.map(quote)}) VALUES (${keys.map(() => "?")})`);
        for (const row of rows) stmt.run(...keys.map(k => toSqliteValue(table, k, row[k])));
      }
      for (const [name, maximum] of Object.entries(maxima)) {
        sqlite.prepare("DELETE FROM sqlite_sequence WHERE name=?").run(name);
        sqlite.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)").run(name, maximum);
      }
    })();
    return { sqlite, db };
  } catch (error) { sqlite.close(); throw error; }
}

export function franchiseSeed(input: DataSet): FranchiseSeed {
  return { franchises: input.franchises.map(f => ({
    id: Number(f.id), canonicalName: String(f.canonical_name), managerName: String(f.manager_name),
    joinedSeason: Number(f.joined_season), departedSeason: f.departed_season as number | null,
    active: Boolean(f.active), accentColor: f.accent_color as string | null, notes: f.notes as string | null,
    managers: input.franchise_managers.filter(m => m.franchise_id === f.id).map(m => ({ managerName: String(m.manager_name), espnOwnerSwid: m.espn_owner_swid as string | null, fromSeason: Number(m.from_season), toSeason: m.to_season as number | null })),
    espnTeamIds: input.team_seasons.filter(t => t.franchise_id === f.id).map(t => ({ season: Number(t.season), espnTeamId: Number(t.espn_team_id) })),
  })) };
}

const NATURAL_KEYS: Record<string, string[]> = {
  team_seasons: ["season", "espn_team_id"], matchups: ["season", "week", "espn_matchup_id"],
  transactions: ["season", "espn_tx_id"], roster_slots: ["season", "week", "team_season_id", "player_id"],
  draft_picks: ["season", "overall_pick"], transaction_items: ["transaction_id", "team_season_id", "player_id", "action", "source"],
};

/** The legacy normalizer rebuilds child rows. Restore durable IDs before stats/events. */
export function stabilizeIds(sqlite: Database.Database, season: number, original: DataSet): void {
  for (const [table, keys] of Object.entries(NATURAL_KEYS)) {
    const natural = (r: Row) => JSON.stringify(keys.map(k => r[k]));
    const known = new Map((original[table] ?? []).map(r => [natural(r), Number(r.id)]));
    const where = table === "transaction_items" ? `transaction_id IN (SELECT id FROM transactions WHERE season=?)` : "season=?";
    const rows = sqlite.prepare(`SELECT * FROM ${quote(table)} WHERE ${where}`).all(season) as Row[];
    const changes = rows.flatMap(r => { const id = known.get(natural(r)); return id !== undefined && id !== r.id ? [{ from: Number(r.id), to: id }] : []; });
    const references: [string, string][] = table === "team_seasons" ? [["matchups", "home_team_season_id"], ["matchups", "away_team_season_id"], ["roster_slots", "team_season_id"], ["draft_picks", "team_season_id"], ["transaction_items", "team_season_id"]] : table === "transactions" ? [["transaction_items", "transaction_id"]] : [];
    // Two phases avoid ID collisions regardless of insertion order.
    for (const { from, to } of changes) {
      sqlite.prepare(`UPDATE ${quote(table)} SET id=? WHERE id=?`).run(-to, from);
      for (const [child, column] of references) sqlite.prepare(`UPDATE ${quote(child)} SET ${quote(column)}=? WHERE ${quote(column)}=?`).run(-to, from);
    }
    for (const { to } of changes) {
      sqlite.prepare(`UPDATE ${quote(table)} SET id=? WHERE id=?`).run(to, -to);
      for (const [child, column] of references) sqlite.prepare(`UPDATE ${quote(child)} SET ${quote(column)}=? WHERE ${quote(column)}=?`).run(to, -to);
    }
  }
}
