/**
 * Franchise identity — the one piece of layer-2 data that does NOT come from
 * ESPN. A "franchise" is the atomic unit of all stats (AGENTS.md); ESPN only
 * knows about `teamId`s that get reused/reshuffled across seasons and
 * `owners[]` SWIDs that identify a manager, not a franchise. This module
 * bridges "ESPN's view of the world" to "our durable franchise identity" via
 * a hand-maintained seed file, `seed/franchises.json`.
 */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { franchiseManagers, franchises } from "../db/schema";
import { SEASON_SCOPE_VIEW_KEY, unwrapLeagueHistoryPayload, type EspnSeasonScopePayload } from "./espn-shapes";
import { getLatestSnapshot, seasonsWithSnapshot } from "./snapshots";
import { asFiniteNumber, asNonEmptyString, asOwnerSwid } from "./parse-utils";

// ---------------------------------------------------------------------------
// Seed file shape
// ---------------------------------------------------------------------------

export interface FranchiseSeedManager {
  managerName: string;
  espnOwnerSwid: string | null;
  fromSeason: number;
  toSeason: number | null;
}

export interface FranchiseSeedTeamMapping {
  season: number;
  espnTeamId: number;
}

export interface FranchiseSeedEntry {
  id: number;
  canonicalName: string;
  managerName: string;
  joinedSeason: number;
  departedSeason: number | null;
  active: boolean;
  accentColor: string | null;
  notes: string | null;
  managers: FranchiseSeedManager[];
  espnTeamIds: FranchiseSeedTeamMapping[];
}

export interface FranchiseSeed {
  franchises: FranchiseSeedEntry[];
}

const EMPTY_SEED: FranchiseSeed = { franchises: [] };

function defaultSeedPath(): string {
  return path.join(process.cwd(), "seed", "franchises.json");
}

/**
 * Reads and shape-validates `seed/franchises.json`. Malformed individual
 * entries are dropped with a warning (defensive — one bad entry shouldn't
 * block every other franchise from resolving); a missing file or a
 * completely malformed top-level shape returns an empty seed with a warning
 * rather than throwing, since a fresh repo legitimately has no seed file yet
 * (bootstrap via `npm run seed:suggest`) and every team will then correctly
 * hard-fail validation with a suggestion, per the brief.
 */
export function loadFranchiseSeed(seedPath: string = defaultSeedPath()): { seed: FranchiseSeed; warnings: string[] } {
  const warnings: string[] = [];

  if (!fs.existsSync(seedPath)) {
    warnings.push(
      `franchise seed not found at ${seedPath} — no franchises are mapped, every team will fail validation. ` +
        `Run "npm run seed:suggest" to generate a starting point.`,
    );
    return { seed: EMPTY_SEED, warnings };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  } catch (err) {
    throw new Error(`franchise seed at ${seedPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const franchisesRaw = raw && typeof raw === "object" ? (raw as { franchises?: unknown }).franchises : undefined;
  if (!Array.isArray(franchisesRaw)) {
    throw new Error(`franchise seed at ${seedPath} must have a top-level "franchises" array`);
  }

  const parsed: FranchiseSeedEntry[] = [];
  for (const [index, entryRaw] of franchisesRaw.entries()) {
    const entry = parseFranchiseSeedEntry(entryRaw, index, warnings);
    if (entry) parsed.push(entry);
  }

  return { seed: { franchises: parsed }, warnings };
}

function parseFranchiseSeedEntry(entryRaw: unknown, index: number, warnings: string[]): FranchiseSeedEntry | null {
  const label = `franchises[${index}]`;
  if (!entryRaw || typeof entryRaw !== "object") {
    warnings.push(`${label}: not an object, skipped`);
    return null;
  }
  const e = entryRaw as Record<string, unknown>;

  const id = asFiniteNumber(e.id);
  const canonicalName = asNonEmptyString(e.canonicalName);
  const managerName = asNonEmptyString(e.managerName);
  const joinedSeason = asFiniteNumber(e.joinedSeason);
  if (id === undefined || !canonicalName || !managerName || joinedSeason === undefined) {
    warnings.push(`${label}: missing required id/canonicalName/managerName/joinedSeason, skipped`);
    return null;
  }

  const managers: FranchiseSeedManager[] = [];
  for (const [mi, mRaw] of (Array.isArray(e.managers) ? e.managers : []).entries()) {
    if (!mRaw || typeof mRaw !== "object") {
      warnings.push(`${label}.managers[${mi}]: not an object, skipped`);
      continue;
    }
    const m = mRaw as Record<string, unknown>;
    const mManagerName = asNonEmptyString(m.managerName);
    const fromSeason = asFiniteNumber(m.fromSeason);
    if (!mManagerName || fromSeason === undefined) {
      warnings.push(`${label}.managers[${mi}]: missing required managerName/fromSeason, skipped`);
      continue;
    }
    managers.push({
      managerName: mManagerName,
      espnOwnerSwid: asNonEmptyString(m.espnOwnerSwid) ?? null,
      fromSeason,
      toSeason: asFiniteNumber(m.toSeason) ?? null,
    });
  }

  const espnTeamIds: FranchiseSeedTeamMapping[] = [];
  for (const [ti, tRaw] of (Array.isArray(e.espnTeamIds) ? e.espnTeamIds : []).entries()) {
    if (!tRaw || typeof tRaw !== "object") {
      warnings.push(`${label}.espnTeamIds[${ti}]: not an object, skipped`);
      continue;
    }
    const t = tRaw as Record<string, unknown>;
    const season = asFiniteNumber(t.season);
    const espnTeamId = asFiniteNumber(t.espnTeamId);
    if (season === undefined || espnTeamId === undefined) {
      warnings.push(`${label}.espnTeamIds[${ti}]: missing required season/espnTeamId, skipped`);
      continue;
    }
    espnTeamIds.push({ season, espnTeamId });
  }

  return {
    id,
    canonicalName,
    managerName,
    joinedSeason,
    departedSeason: asFiniteNumber(e.departedSeason) ?? null,
    active: typeof e.active === "boolean" ? e.active : true,
    accentColor: asNonEmptyString(e.accentColor) ?? null,
    notes: asNonEmptyString(e.notes) ?? null,
    managers,
    espnTeamIds,
  };
}

/**
 * Applies the seed to the `franchises` + `franchise_managers` tables:
 * franchises are upserted by their explicit `id`; each franchise's managers
 * are fully replaced (delete-then-reinsert) since `franchise_managers` has
 * no natural unique key to upsert against — this stays idempotent and keeps
 * the seed file as the single source of truth for both tables.
 */
export function applyFranchiseSeed(db: Db, seed: FranchiseSeed): void {
  db.transaction((tx) => {
    for (const f of seed.franchises) {
      tx.insert(franchises)
        .values({
          id: f.id,
          canonicalName: f.canonicalName,
          managerName: f.managerName,
          joinedSeason: f.joinedSeason,
          departedSeason: f.departedSeason,
          active: f.active,
          accentColor: f.accentColor,
          notes: f.notes,
        })
        .onConflictDoUpdate({
          target: franchises.id,
          set: {
            canonicalName: f.canonicalName,
            managerName: f.managerName,
            joinedSeason: f.joinedSeason,
            departedSeason: f.departedSeason,
            active: f.active,
            accentColor: f.accentColor,
            notes: f.notes,
          },
        })
        .run();

      tx.delete(franchiseManagers).where(eq(franchiseManagers.franchiseId, f.id)).run();
      if (f.managers.length > 0) {
        tx.insert(franchiseManagers)
          .values(
            f.managers.map((m) => ({
              franchiseId: f.id,
              managerName: m.managerName,
              espnOwnerSwid: m.espnOwnerSwid,
              fromSeason: m.fromSeason,
              toSeason: m.toSeason,
            })),
          )
          .run();
      }
    }
  });
}

/**
 * Resolves an ESPN team (in a given season) to a franchise id.
 * Resolution order: explicit `(season, espnTeamId)` mapping entry, then an
 * `ownerSwid` match against a franchise manager whose `[fromSeason, toSeason]`
 * window covers `season`, then `null` (unmapped — a hard validation failure
 * for that season, handled by the caller in `normalize.ts`).
 */
export function resolveFranchise(
  seed: FranchiseSeed,
  season: number,
  espnTeamId: number,
  ownerSwids: readonly string[],
): number | null {
  for (const franchise of seed.franchises) {
    if (franchise.espnTeamIds.some((m) => m.season === season && m.espnTeamId === espnTeamId)) {
      return franchise.id;
    }
  }

  for (const franchise of seed.franchises) {
    for (const manager of franchise.managers) {
      if (!manager.espnOwnerSwid) continue;
      if (!ownerSwids.includes(manager.espnOwnerSwid)) continue;
      if (season < manager.fromSeason) continue;
      if (manager.toSeason !== null && season > manager.toSeason) continue;
      return franchise.id;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Bootstrap helper: `npm run seed:suggest`
// ---------------------------------------------------------------------------

export { SEASON_SCOPE_VIEW_KEY } from "./espn-shapes";

export interface FranchiseSuggestion {
  /** Grouping key: the primary owner SWID, or a synthetic per-team key when no owner is known. */
  groupKey: string;
  displayName: string | null;
  seasonsSeen: number[];
  teamNames: string[];
  espnTeamIds: FranchiseSeedTeamMapping[];
  ownerSwids: string[];
}

/**
 * Scans every season with an archived season-scope snapshot and groups
 * `teams[]` entries by their primary owner SWID (`owners[0]`), across
 * seasons — a bootstrap draft, not an authoritative mapping. Teams with no
 * resolvable owner SWID each get their own singleton group. Deliberately
 * simple (a real league's co-ownership / manager handoffs need a human to
 * review the draft output before it becomes `seed/franchises.json`).
 */
export function suggestFranchises(db: Db): FranchiseSuggestion[] {
  const groups = new Map<string, FranchiseSuggestion>();

  for (const season of seasonsWithSnapshot(db, SEASON_SCOPE_VIEW_KEY)) {
    const snapshot = getLatestSnapshot(db, { season, view: SEASON_SCOPE_VIEW_KEY, scoringPeriod: null });
    if (!snapshot) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(snapshot.payload);
    } catch {
      continue; // malformed snapshot — not this function's job to report parse errors
    }
    // Real pre-2018 (leagueHistory) snapshots wrap the league object in an array — unwrap it the
    // same way validate.ts/normalize.ts do, or these seasons silently contribute zero suggestions.
    const unwrapped = unwrapLeagueHistoryPayload(parsed, season);
    if (unwrapped === null || typeof unwrapped !== "object") continue;
    const json = unwrapped as EspnSeasonScopePayload;

    const memberNameBySwid = new Map<string, string>();
    for (const member of Array.isArray(json.members) ? json.members : []) {
      const swid = asNonEmptyString(member?.id);
      const displayName = asNonEmptyString(member?.displayName);
      if (swid && displayName) memberNameBySwid.set(swid, displayName);
    }

    for (const team of Array.isArray(json.teams) ? json.teams : []) {
      const espnTeamId = asFiniteNumber(team?.id);
      if (espnTeamId === undefined) continue;

      const owners = Array.isArray(team.owners) ? team.owners.map(asOwnerSwid).filter((s): s is string => !!s) : [];
      const groupKey = owners[0] ?? `no-owner:${season}:${espnTeamId}`;
      const teamName =
        asNonEmptyString(team.name) ??
        [asNonEmptyString(team.location), asNonEmptyString(team.nickname)].filter(Boolean).join(" ").trim() ??
        `Team ${espnTeamId}`;

      const existing = groups.get(groupKey);
      const entry: FranchiseSuggestion = existing ?? {
        groupKey,
        displayName: owners[0] ? (memberNameBySwid.get(owners[0]) ?? null) : null,
        seasonsSeen: [],
        teamNames: [],
        espnTeamIds: [],
        ownerSwids: [],
      };

      if (!entry.seasonsSeen.includes(season)) entry.seasonsSeen.push(season);
      if (teamName && !entry.teamNames.includes(teamName)) entry.teamNames.push(teamName);
      entry.espnTeamIds.push({ season, espnTeamId });
      for (const swid of owners) {
        if (!entry.ownerSwids.includes(swid)) entry.ownerSwids.push(swid);
      }
      if (!entry.displayName && owners[0]) entry.displayName = memberNameBySwid.get(owners[0]) ?? null;

      groups.set(groupKey, entry);
    }
  }

  return [...groups.values()].sort((a, b) => a.seasonsSeen[0]! - b.seasonsSeen[0]!);
}

/** Renders `suggestFranchises` output as a ready-to-paste `franchises.json` document. */
export function suggestionsToSeedJson(suggestions: readonly FranchiseSuggestion[]): string {
  const draft: FranchiseSeed = {
    franchises: suggestions.map((s, index) => ({
      id: index + 1,
      canonicalName: s.teamNames[s.teamNames.length - 1] ?? s.groupKey,
      managerName: s.displayName ?? s.groupKey,
      joinedSeason: s.seasonsSeen[0]!,
      departedSeason: null,
      active: true,
      accentColor: null,
      notes: s.teamNames.length > 1 ? `Team names seen: ${s.teamNames.join(", ")}` : null,
      managers: s.ownerSwids.map((swid) => ({
        managerName: s.displayName ?? s.groupKey,
        espnOwnerSwid: swid,
        fromSeason: s.seasonsSeen[0]!,
        toSeason: null,
      })),
      espnTeamIds: s.espnTeamIds,
    })),
  };
  return JSON.stringify(draft, null, 2);
}
