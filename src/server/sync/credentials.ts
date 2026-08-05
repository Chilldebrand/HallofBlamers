/**
 * ESPN credential + league-id resolution.
 *
 * Cookies live in `app_settings` so they're rotatable from `/admin` without
 * SSH access (see AGENTS.md). Environment variables are only a bootstrap
 * path: on first use, if the DB has nothing yet, env values are copied in
 * and the DB becomes the source of truth from then on.
 *
 * SWID BRACES: ESPN's SWID cookie value is issued WITH surrounding curly
 * braces, e.g. `{ABC12345-DE67-...}`. `EspnClient` interpolates `swid`
 * verbatim into the `Cookie` header as `SWID={swid}` — it does not add or
 * strip braces itself. This module therefore stores and returns whatever
 * string was provided, byte-for-byte: do NOT trim, add, or strip braces here
 * when bootstrapping from `ESPN_SWID`. If an operator pastes the cookie
 * value without braces, auth will fail with EspnAuthError and that's a
 * config problem to fix at the source, not something to paper over here.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { appSettings } from "../db/schema";
import type { EspnCookies } from "../espn/types";

const ESPN_S2_KEY = "espn_s2";
const SWID_KEY = "swid";
const LEAGUE_ID_KEY = "espn_league_id";

function readSetting(db: Db, key: string): unknown {
  const row = db
    .select({ valueJson: appSettings.valueJson })
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .get();
  return row?.valueJson;
}

function writeSetting(db: Db, key: string, value: unknown): void {
  const now = new Date();
  db.insert(appSettings)
    .values({ key, valueJson: value, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { valueJson: value, updatedAt: now } })
    .run();
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Resolves a single credential field: the DB value wins if present; a
 * non-empty env value fills the gap ONLY when the DB has nothing stored yet
 * for this key, and is persisted so future calls read it back from the DB
 * without touching the env var again.
 *
 * Deliberately per-key, not per-pair (fix round 1): a pair-level bootstrap
 * — "if both env vars are set, write both keys" — clobbers an already-correct
 * DB value for one key whenever the OTHER key happens to still be missing
 * and both env vars are set. Resolving each field independently means an
 * existing DB value is NEVER overwritten by env, regardless of the other
 * field's state.
 */
function resolveCredentialField(db: Db, key: string, envValue: string | undefined): string | undefined {
  const stored = readSetting(db, key);
  if (nonEmptyString(stored)) {
    return stored;
  }
  if (nonEmptyString(envValue)) {
    writeSetting(db, key, envValue);
    return envValue;
  }
  return undefined;
}

/**
 * Reads ESPN auth cookies from `app_settings` (keys `espn_s2` / `swid`),
 * field by field: each key's DB value wins if present; a missing key falls
 * back to its `ESPN_S2` / `ESPN_SWID` env var and persists it (bootstrap
 * path) independently of the other key. Returns `null` unless BOTH fields
 * end up resolved from some source (public-league mode: unauthenticated
 * fetches only) — but a single resolved field is still persisted even when
 * the overall result is `null`, so partial env config accumulates in the DB
 * across runs instead of being silently dropped.
 */
export function getEspnCredentials(db: Db): EspnCookies | null {
  const espnS2 = resolveCredentialField(db, ESPN_S2_KEY, process.env.ESPN_S2);
  const swid = resolveCredentialField(db, SWID_KEY, process.env.ESPN_SWID);

  if (espnS2 !== undefined && swid !== undefined) {
    return { espn_s2: espnS2, swid };
  }

  return null;
}

/**
 * Reads the ESPN league id from `app_settings` (key `espn_league_id`),
 * falling back to and persisting `ESPN_LEAGUE_ID` env var. Throws if neither
 * source has it — there is no sensible default.
 */
export function getLeagueId(db: Db): number {
  const stored = readSetting(db, LEAGUE_ID_KEY);
  if (typeof stored === "number" && Number.isFinite(stored)) {
    return stored;
  }

  const envValue = process.env.ESPN_LEAGUE_ID;
  if (nonEmptyString(envValue)) {
    const parsed = Number(envValue);
    if (!Number.isFinite(parsed)) {
      throw new Error(`ESPN_LEAGUE_ID env value "${envValue}" is not a valid number.`);
    }
    writeSetting(db, LEAGUE_ID_KEY, parsed);
    return parsed;
  }

  throw new Error(
    'No ESPN league id configured. Set app_settings key "espn_league_id" (e.g. from /admin) or the ' +
      "ESPN_LEAGUE_ID environment variable.",
  );
}
