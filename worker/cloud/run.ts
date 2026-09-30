import { createWorkspace, franchiseSeed, stabilizeIds, compactSnapshotPayload, type DataSet, type Row } from "./workspace";
import { DERIVED_TABLES, SEASON_TABLES } from "./repository";
import type { BackfillEspnClient } from "../../src/server/espn/backfill";
import type { EspnView } from "../../src/server/espn/types";
import { normalizeSeason } from "../../src/server/sync/normalize";
import { applyCorrections } from "../../src/server/sync/corrections";
import { runStatBuild } from "../../src/server/stats/build";
import { storeSnapshot } from "../../src/server/sync/snapshots";
import { emitEvents } from "../../src/server/sync/emit-events";
import { SEASON_SCOPE_VIEW_KEY, WEEK_SCOPE_VIEW_KEY, TRANSACTIONS_VIEW_KEY, unwrapLeagueHistoryPayload } from "../../src/server/sync/espn-shapes";
import { quote } from "../../migration/postgres-schema";

export type CloudTier = "live" | "hourly" | "daily";
export function periodsToFetch(tier: CloudTier, latest: number, boxscores: Set<number>, transactions: Set<number>): number[] {
  if (!Number.isInteger(latest) || latest < 0 || latest > 25) throw new Error("Invalid scoring period");
  if (tier === "live") return latest ? [latest] : [];
  return Array.from({ length: latest }, (_, i) => i + 1).filter(p => tier === "daily" || p === latest || !boxscores.has(p) || !transactions.has(p));
}

export async function refreshWorkspace(input: DataSet, maxima: Record<string, number>, client: BackfillEspnClient, options: { season: number; tier: CloudTier; leagueId: number; sleep: (ms: number) => Promise<void> }) {
  const { sqlite, db } = createWorkspace(input, maxima);
  const { season, tier } = options;
  let viewsFetched = 0;
  let snapshotsNew = 0;
  try {
    async function fetchAndStore(view: string, period?: number) {
      if (viewsFetched) await options.sleep(2200);
      const result = await client.fetchLeague({ season, views: view.split(",") as EspnView[], scoringPeriodId: period });
      viewsFetched++;
      const stored = storeSnapshot(db, { season, view, scoringPeriod: period ?? null, url: result.url, httpStatus: result.status, payload: result.payload });
      if (stored.inserted) snapshotsNew++;
      return result.json;
    }
    const payload = unwrapLeagueHistoryPayload(await fetchAndStore(SEASON_SCOPE_VIEW_KEY)) as { id?: number; seasonId?: number; status?: { latestScoringPeriod?: number } };
    if ((payload.id !== undefined && payload.id !== options.leagueId) || (payload.seasonId !== undefined && payload.seasonId !== season)) throw new Error("ESPN returned another league or season");
    const latest = payload.status?.latestScoringPeriod;
    if (latest === undefined) throw new Error("ESPN did not provide the current scoring period");
    const existing = (view: string) => new Set((input.snapshots ?? []).filter(s => s.view === view && s.scoring_period !== null).map(s => Number(s.scoring_period)));
    for (const period of periodsToFetch(tier, latest, existing(WEEK_SCOPE_VIEW_KEY), existing(TRANSACTIONS_VIEW_KEY))) {
      await fetchAndStore(WEEK_SCOPE_VIEW_KEY, period);
      if (tier !== "live") await fetchAndStore(TRANSACTIONS_VIEW_KEY, period);
    }
    const normalized = normalizeSeason(db, season, { leagueId: options.leagueId, franchiseSeed: franchiseSeed(input), _skipFranchiseSeedApply: true, _skipCorrectionsApply: true });
    if (!normalized.written.team_seasons) throw new Error("Normalization failed validation; no data published");
    stabilizeIds(sqlite, season, input);
    const corrected = applyCorrections(db, season);
    const built = runStatBuild(db, { force: true });
    if (built.status !== "ok") throw new Error("Statistics build failed; no data published");
    emitEvents(db, { season });
    const rows: DataSet = {};
    for (const table of [...DERIVED_TABLES, "leagues", "players"]) rows[table] = sqlite.prepare(`SELECT * FROM ${quote(table)}`).all() as Row[];
    for (const table of [...SEASON_TABLES, "seasons"]) rows[table] = sqlite.prepare(`SELECT * FROM ${quote(table)} WHERE season=?`).all(season) as Row[];
    rows.transaction_items = sqlite.prepare("SELECT * FROM transaction_items WHERE transaction_id IN (SELECT id FROM transactions WHERE season=?)").all(season) as Row[];
    rows.stat_builds = sqlite.prepare("SELECT * FROM stat_builds WHERE id=?").all(built.buildId) as Row[];
    for (const table of ["snapshots", "events"]) rows[table] = sqlite.prepare(`SELECT * FROM ${quote(table)} WHERE id>?`).all(maxima[table] ?? 0) as Row[];
    rows.cloud_snapshot_cache = sqlite.prepare("SELECT id,view,payload FROM snapshots").all().map(value => {
      const row = value as Row;
      return { snapshot_id: row.id, payload: compactSnapshotPayload(String(row.view), String(row.payload)) };
    });
    return { rows, viewsFetched, snapshotsNew, latestScoringPeriod: latest, buildId: built.buildId, warningCount: normalized.warnings.length + corrected.warnings.length + built.warnings.length, outputBytes: Buffer.byteLength(JSON.stringify(rows)) };
  } finally { sqlite.close(); }
}
