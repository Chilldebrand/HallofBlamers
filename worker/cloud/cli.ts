import { Client } from "pg";
import { EspnClient, EspnAuthError } from "../../src/server/espn/client";
import { determineCurrentSeasonYear } from "../../src/server/sync/current-season";
import { isWithinLiveWindow } from "../../src/server/sync/live-window";
import { loadInputs, publishGeneration, LOCK_KEY } from "./repository";
import { refreshWorkspace, type CloudTier } from "./run";

async function main() {
  const started = Date.now();
  const tier = (process.argv[2] ?? "hourly") as CloudTier;
  if (!["live", "hourly", "daily"].includes(tier)) throw new Error("Invalid sync tier");
  if (process.env.PGUSER !== "postgres.aridozcvdxlfnibcnejf" || process.env.PGHOST !== "aws-0-ca-central-1.pooler.supabase.com") throw new Error("Unexpected target project");
  if (tier === "live" && !isWithinLiveWindow(new Date())) { console.log(JSON.stringify({ state: "skipped", reason: "outside_game_window" })); return; }
  const dryRun = process.argv.includes("--dry-run");
  const pg = new Client({ ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 15000, application_name: "hallofblamers-cloud-sync", keepAlive: true });
  await pg.connect();
  let locked = false;
  let runId: number | undefined;
  try {
    locked = Boolean((await pg.query("SELECT pg_try_advisory_lock($1) AS acquired", [LOCK_KEY])).rows[0].acquired);
    if (!locked) { console.log(JSON.stringify({ state: "skipped", reason: "another_sync_running" })); return; }
    const season = determineCurrentSeasonYear();
    if (tier === "live") {
      const { rows: [state] } = await pg.query("SELECT EXISTS(SELECT 1 FROM hob_private.seasons WHERE season=$1 AND status='active') AND EXISTS(SELECT 1 FROM hob_private.matchups WHERE season=$1 AND NOT is_final) AS underway", [season]);
      if (!state.underway) { console.log(JSON.stringify({ state: "skipped", reason: "season_not_underway" })); return; }
    }
    const databaseBytes = Number((await pg.query("SELECT pg_database_size(current_database()) AS bytes")).rows[0].bytes);
    if (databaseBytes >= 350_000_000) throw new Error("Storage budget reached");
    const settings = Object.fromEntries((await pg.query("SELECT key,value_json FROM hob_private.app_settings WHERE key IN ('espn_s2','swid','espn_league_id')")).rows.map(r => [r.key, r.value_json]));
    if (Number(settings.espn_league_id) !== 1690915927) throw new Error("Unexpected league");
    if (!dryRun) {
      await pg.query("UPDATE hob_private.sync_runs SET status='failed',finished_at=now(),error_text='Previous cloud sync ended before publication' WHERE status='running'");
      runId = Number((await pg.query("INSERT INTO hob_private.sync_runs(started_at,tier,status) VALUES(now(),$1,'running') RETURNING id", [tier])).rows[0].id);
    }
    const loaded = await loadInputs(pg, season);
    if (loaded.inputBytes > 32_000_000) throw new Error("Computation input budget exceeded");
    const client = new EspnClient({ leagueId: 1690915927, cookies: settings.espn_s2 && settings.swid ? { espn_s2: settings.espn_s2, swid: settings.swid } : undefined,
      fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }),
    });
    const result = await refreshWorkspace(loaded.input, loaded.maxima, client, { season, tier, leagueId: 1690915927, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) });
    if (result.outputBytes > 32_000_000) throw new Error("Publication budget exceeded");
    if (!dryRun) await publishGeneration(pg, { ...result, season, runId: runId! });
    console.log(JSON.stringify({ state: dryRun ? "validated" : "completed", season, tier, latestScoringPeriod: result.latestScoringPeriod, generationId: result.buildId, viewsFetched: result.viewsFetched, snapshotsNew: result.snapshotsNew, warningCount: result.warningCount, inputBytes: loaded.inputBytes, outputBytes: result.outputBytes, elapsedMs: Date.now() - started }));
  } catch (error) {
    if (runId !== undefined) await pg.query("UPDATE hob_private.sync_runs SET status=$2,finished_at=now(),error_text=$3 WHERE id=$1", [runId, error instanceof EspnAuthError ? "auth_failed" : "failed", error instanceof EspnAuthError ? "ESPN credentials require renewal" : "Cloud sync failed; previous published data retained"]).catch(() => {});
    throw error;
  } finally {
    if (locked) await pg.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    await pg.end();
  }
}

main().catch((error: unknown) => {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : error instanceof EspnAuthError ? "ESPN_AUTH" : "SYNC_FAILED";
  console.error(JSON.stringify({ state: "failed", code }));
  process.exitCode = 1;
});
