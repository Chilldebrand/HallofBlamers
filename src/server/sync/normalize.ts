/**
 * The normalizer — projects layer-1 snapshots into layer-2 normalized
 * tables. Per AGENTS.md's golden rule, this is a PURE, IDEMPOTENT,
 * REBUILDABLE function: `raw snapshots + seed files + corrections ->
 * normalized tables`. Wiping and re-running always produces identical
 * results (module the `id` autoincrement counters on child tables — see the
 * test file for how idempotence is actually asserted).
 *
 * `normalizeSeason` does all its DB work inside ONE transaction: it deletes
 * the season's rows from every season-scoped table, rebuilds them from the
 * latest non-superseded snapshots, and applies active corrections last.
 * `leagues` and `players` are global upserts, never deleted. `franchises` /
 * `franchise_managers` come from `seed/franchises.json` (franchise-map.ts),
 * never from ESPN.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  excludeLoneLegs,
  inferTradeItemsFromRosterDiff,
  keepDominantBlock,
  keepDominantComponent,
  resolveCrossGroupClaims,
  type GroupClaim,
  type InferredTradeItem,
  type RosterEntry,
} from "../../engines/tradeRosterDiff";
import type { Db } from "../db/client";
import {
  draftPicks,
  leagues,
  matchups,
  players,
  rosterSlots,
  seasons,
  teamSeasons,
  transactionItems,
  transactions,
  weeks,
  type NewDraftPick,
  type NewMatchup,
  type NewRosterSlot,
  type Transaction,
  type TransactionItem,
} from "../db/schema";
import { LINEUP_SLOT_MAP, POSITION_MAP, PRO_TEAM_MAP } from "../espn/constants";
import { applyCorrections } from "./corrections";
import { getLeagueId } from "./credentials";
import { SEASON_SCOPE_VIEW_KEY, TRANSACTIONS_VIEW_KEY, WEEK_SCOPE_VIEW_KEY } from "./espn-shapes";
import type {
  EspnDraftPick,
  EspnPlayer,
  EspnScheduleEntry,
  EspnSeasonScopePayload,
  EspnSeasonStatus,
  EspnTeam,
  EspnTransaction,
  EspnTransactionsPayload,
  EspnWeekScopePayload,
} from "./espn-shapes";
import {
  applyFranchiseSeed,
  loadFranchiseSeed,
  resolveFranchise,
  suggestFranchises,
  suggestionsToSeedJson,
  type FranchiseSeed,
} from "./franchise-map";
import { asFiniteNumber, asNonEmptyString, asOwnerSwid } from "./parse-utils";
import { getLatestSnapshot, periodsWithSnapshot, seasonsWithSnapshot } from "./snapshots";
import { validateSeasonScopePayload } from "./validate";

export { SEASON_SCOPE_VIEW_KEY, TRANSACTIONS_VIEW_KEY, WEEK_SCOPE_VIEW_KEY };

export interface NormalizeOptions {
  /** Injectable for tests; defaults to `loadFranchiseSeed(franchiseSeedPath).seed`. */
  franchiseSeed?: FranchiseSeed;
  /** Only consulted when `franchiseSeed` isn't given directly. */
  franchiseSeedPath?: string;
  /** Injectable for tests; defaults to `getLeagueId(db)` (app_settings / ESPN_LEAGUE_ID). */
  leagueId?: number;
  /**
   * @internal Skips the `applyFranchiseSeed` call this function normally
   * makes on every invocation. Set by `normalizeAll`, which already applies
   * the seed once before its per-season loop — not part of the public
   * contract; a direct `normalizeSeason` call should never need this.
   */
  _skipFranchiseSeedApply?: boolean;
  /** Cloud adapter restores durable row IDs before applying corrections. */
  _skipCorrectionsApply?: boolean;
}

export interface NormalizeSummary {
  season: number;
  /** Row counts actually written this call, keyed by table name. Empty when the season was skipped. */
  written: Record<string, number>;
  /** Includes both benign parsing notes and, for a skipped season, the reason(s) it was skipped. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rebuilds one season's layer-2 tables from its latest archived snapshots.
 * Never throws for season-data problems (missing snapshot, failed
 * validation, unmapped franchises) — those produce `written: {}` and a
 * `warnings` entry explaining why, so `normalizeAll` can keep going for
 * other seasons. Genuinely unrecoverable configuration problems (no ESPN
 * league id configured anywhere) still throw, same as `backfill.ts`.
 */
export function normalizeSeason(db: Db, season: number, opts?: NormalizeOptions): NormalizeSummary {
  const warnings: string[] = [];

  let franchiseSeed: FranchiseSeed;
  if (opts?.franchiseSeed) {
    franchiseSeed = opts.franchiseSeed;
  } else {
    const loaded = loadFranchiseSeed(opts?.franchiseSeedPath);
    franchiseSeed = loaded.seed;
    warnings.push(...loaded.warnings);
  }
  if (!opts?._skipFranchiseSeedApply) {
    applyFranchiseSeed(db, franchiseSeed);
  }

  const leagueId = opts?.leagueId ?? getLeagueId(db);

  const snapshot = getLatestSnapshot(db, { season, view: SEASON_SCOPE_VIEW_KEY, scoringPeriod: null });
  if (!snapshot) {
    warnings.push(
      `season ${season}: SKIPPED — no season-scope snapshot archived (view "${SEASON_SCOPE_VIEW_KEY}"); nothing to normalize`,
    );
    return { season, written: {}, warnings };
  }

  const validation = validateSeasonScopePayload(snapshot.payload, season);
  if (!validation.valid || !validation.json) {
    warnings.push(`season ${season}: SKIPPED — failed validation:`);
    warnings.push(...validation.errors.map((e) => `  - ${e}`));
    return { season, written: {}, warnings };
  }
  const obj = validation.json;

  const parsedTeams = parseTeams(obj, warnings);
  const unmapped = parsedTeams.filter((t) => resolveFranchise(franchiseSeed, season, t.espnTeamId, t.ownerSwids) === null);

  if (unmapped.length > 0) {
    warnings.push(`season ${season}: SKIPPED — ${unmapped.length} team(s) have no franchise mapping:`);
    for (const team of unmapped) {
      warnings.push(`  - espnTeamId=${team.espnTeamId} "${team.teamName}" owners=${JSON.stringify(team.ownerSwids)}`);
    }
    const unmappedKeys = new Set(unmapped.map((t) => t.espnTeamId));
    const suggestions = suggestFranchises(db).filter(
      (s) =>
        unmapped.some((t) => t.ownerSwids.some((swid) => s.ownerSwids.includes(swid))) ||
        s.espnTeamIds.some((m) => m.season === season && unmappedKeys.has(m.espnTeamId)),
    );
    warnings.push(
      "Paste this into seed/franchises.json (merge with any existing entries, renumbering `id` to avoid collisions):",
    );
    warnings.push(suggestionsToSeedJson(suggestions));
    return { season, written: {}, warnings };
  }

  // Weekly (`mBoxscore,mMatchupScore,mRoster`) snapshots are the ONLY reliable source of
  // `playoffTierType` — confirmed against real archived data that it never appears on the
  // season-scope `schedule[]` (see espn-shapes.ts's `EspnWeeklyScheduleEntry` docstring). Each
  // weekly snapshot carries the FULL season's schedule (not just its own week) with tier data on
  // every entry, so loading whichever weekly snapshots we have is enough to build a complete
  // entry-id -> tier lookup, merged onto the season-scope schedule for `weeks`/`matchups`.
  const weekNumbers = distinctWeekNumbers(obj.schedule ?? [], warnings);
  const weeklyPayloads = loadWeeklyPayloads(db, season, weekNumbers, warnings);
  const tierByEntryId = buildTierByEntryId(weeklyPayloads);
  const matchupPeriodCount = asFiniteNumber(obj.settings?.scheduleSettings?.matchupPeriodCount);
  const weeksMeta = computeWeeksMeta(obj.schedule ?? [], tierByEntryId, matchupPeriodCount, warnings);

  // Transactions: confirmed by live probe (Task 7) that `mTransactions2` only returns data when
  // fetched WITH a `scoringPeriodId` — the season-scope combined view (which lists mTransactions2
  // among its views) never actually carries transaction data in practice. Aggregate every
  // archived per-period snapshot for this season, deduped by ESPN transaction id (a transaction
  // can legitimately show up in more than one period's response). `obj.transactions` (season-scope)
  // is kept as a fallback merge — harmless, since it's empty in every real payload seen so far.
  const txs = loadAndMergeTransactions(db, season, obj, warnings);

  let written: Record<string, number> = {};

  try {
    db.transaction((tx) => {
      const w: Record<string, number> = {};

      deleteSeasonRows(tx, season);

      const leagueRow = upsertLeague(tx, leagueId, obj, season);
      w.leagues = 1;

      insertSeasonRow(tx, season, leagueRow.id, obj, parsedTeams.length, weeksMeta, matchupPeriodCount, warnings);
      w.seasons = 1;

      const playoffTeamIds = teamsInWinnersBracket(obj.schedule ?? [], tierByEntryId);
      const teamSeasonIdByEspnId = insertTeamSeasons(tx, season, parsedTeams, franchiseSeed, playoffTeamIds);
      w.team_seasons = teamSeasonIdByEspnId.size;

      w.weeks = insertWeeks(tx, season, weeksMeta);
      w.matchups = insertMatchups(tx, season, obj.schedule ?? [], teamSeasonIdByEspnId, tierByEntryId, warnings);

      const playerMetaById = new Map<number, ParsedPlayerMeta>();
      const rosterEntries: RosterSlotCandidate[] = [];
      for (const [week, weekJson] of weeklyPayloads) {
        rosterEntries.push(...parseWeeklyRoster(week, weekJson, playerMetaById, warnings));
      }

      const picks = Array.isArray(obj.draftDetail?.picks) ? (obj.draftDetail!.picks as EspnDraftPick[]) : [];
      const placeholderIds = new Set<number>();
      for (const p of picks) {
        const id = asFiniteNumber(p.playerId);
        if (id !== undefined && !playerMetaById.has(id)) placeholderIds.add(id);
      }
      for (const t of txs) {
        for (const item of t.items ?? []) {
          const id = asFiniteNumber(item.playerId);
          if (id !== undefined && !playerMetaById.has(id)) placeholderIds.add(id);
        }
      }
      w.players = upsertPlayers(tx, playerMetaById, placeholderIds);

      w.roster_slots = insertRosterSlots(tx, season, rosterEntries, teamSeasonIdByEspnId, warnings);

      const txResult = insertTransactions(tx, season, txs, teamSeasonIdByEspnId, warnings);
      w.transactions = txResult.transactions;
      w.transaction_items = txResult.items;
      const inferredItems = recoverItemlessTrades(tx, season, txs, teamSeasonIdByEspnId, warnings);
      w.transaction_items += inferredItems;
      if (inferredItems > 0) w.transaction_items_inferred = inferredItems;

      w.draft_picks = insertDraftPicks(tx, season, picks, teamSeasonIdByEspnId, warnings);

      if (!opts?._skipCorrectionsApply) {
        const correctionResult = applyCorrections(tx, season);
        warnings.push(...correctionResult.warnings);
      }

      // Only commit to the outer `written` once the whole transaction body has run without
      // throwing — better-sqlite3 rolls the DB back on a thrown error, and this keeps the
      // returned summary's `written: {}` truthfully matching "nothing was actually written".
      written = w;
    });
  } catch (err) {
    warnings.push(
      `season ${season}: SKIPPED — write transaction failed (rolled back): ${err instanceof Error ? err.message : String(err)}`,
    );
    return { season, written: {}, warnings };
  }

  return { season, written, warnings };
}

/** Normalizes every season that has an archived season-scope snapshot, in ascending order. */
export function normalizeAll(db: Db, opts?: NormalizeOptions): NormalizeSummary[] {
  let franchiseSeed = opts?.franchiseSeed;
  const warnings: string[] = [];
  if (!franchiseSeed) {
    const loaded = loadFranchiseSeed(opts?.franchiseSeedPath);
    franchiseSeed = loaded.seed;
    warnings.push(...loaded.warnings);
  }

  // Applied ONCE here rather than once per season inside normalizeSeason's loop body — it's
  // idempotent either way, but there's no reason to redo the same upsert N times for an N-season
  // run. `_skipFranchiseSeedApply` tells each per-season call it doesn't need to repeat this.
  applyFranchiseSeed(db, franchiseSeed);

  const seasonNumbers = seasonsWithSnapshot(db, SEASON_SCOPE_VIEW_KEY);
  const summaries = seasonNumbers.map((season) =>
    normalizeSeason(db, season, { ...opts, franchiseSeed, _skipFranchiseSeedApply: true }),
  );

  // Franchise-seed load warnings (if any) surface once, attached to the first summary, rather
  // than duplicated across every season — normalizeSeason itself re-loads+warns per season only
  // when the caller didn't pre-resolve a seed (see above: we always pass one down here).
  if (warnings.length > 0) {
    if (summaries.length > 0) {
      summaries[0]!.warnings.unshift(...warnings);
    } else {
      // No season to attach these to (nothing had a snapshot archived at all) — surface them
      // anyway rather than silently dropping a real problem, e.g. a missing/malformed seed file.
      for (const w of warnings) console.warn(`[normalizeAll] ${w}`);
    }
  }

  return summaries;
}

// ---------------------------------------------------------------------------
// Deletion (children before parents, per FK constraints — see schema.ts)
// ---------------------------------------------------------------------------

function deleteSeasonRows(tx: Db, season: number): void {
  const txIds = tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.season, season))
    .all()
    .map((r) => r.id);
  if (txIds.length > 0) {
    tx.delete(transactionItems).where(inArray(transactionItems.transactionId, txIds)).run();
  }
  tx.delete(draftPicks).where(eq(draftPicks.season, season)).run();
  tx.delete(rosterSlots).where(eq(rosterSlots.season, season)).run();
  tx.delete(matchups).where(eq(matchups.season, season)).run();
  tx.delete(transactions).where(eq(transactions.season, season)).run();
  tx.delete(weeks).where(eq(weeks.season, season)).run();
  tx.delete(teamSeasons).where(eq(teamSeasons.season, season)).run();
  tx.delete(seasons).where(eq(seasons.season, season)).run();
}

// ---------------------------------------------------------------------------
// leagues / seasons
// ---------------------------------------------------------------------------

function upsertLeague(tx: Db, espnLeagueId: number, obj: EspnSeasonScopePayload, season: number) {
  const name = asNonEmptyString(obj.settings?.name) ?? `League ${espnLeagueId}`;
  return tx
    .insert(leagues)
    .values({ espnLeagueId, name, firstSeason: season })
    .onConflictDoUpdate({
      target: leagues.espnLeagueId,
      // Global-min so processing seasons out of order (or a single mid-history season on its
      // own) never regresses firstSeason once an earlier season has been normalized.
      set: { name, firstSeason: sql`min(${leagues.firstSeason}, ${season})` },
    })
    .returning()
    .get();
}

type WeekType = "regular" | "playoff" | "consolation";

interface WeekMeta {
  week: number;
  scoringPeriodId: number;
  weekType: WeekType;
  isComplete: boolean;
}

/**
 * `regSeasonWeeks`/`status` derived from the weeks actually built rather than guessed from
 * `status.*` fields directly, EXCEPT for the specific "all currently-recorded weeks are complete"
 * case, where `status.*` is now the tie-breaker (see below) — keeps `regSeasonWeeks` in sync with
 * whatever `weeks` ends up containing, per the module docstring + brief's "Mapping rules" for
 * `weeks`/`seasons`.
 *
 * "Every week we currently know about is complete" is NOT the same fact as "the season is over":
 * ESPN doesn't create playoff-week `schedule[]` entries until bracket seeding is determined, so
 * a season that's finished its entire regular season but hasn't had its playoffs seeded yet has
 * `weeksMeta` containing ONLY regular-season weeks, all complete — `weeksMeta.every(isComplete)`
 * alone would call that 'complete' three weeks early. Confirmed empirically against a real
 * archived season-scope payload (real 2026, pre-season): `status.finalScoringPeriod` (17, the
 * league's true final period including playoffs, published from day one based on league
 * configuration) is present and reliable independent of how many `schedule[]` entries currently
 * exist, while `status.latestScoringPeriod` (0 pre-season, rising as real weeks get scored) tracks
 * actual progress — `latestScoringPeriod >= finalScoringPeriod` is ESPN's own authoritative
 * "has this season truly finished scoring" signal. Verified against every other real archived
 * season (2015, 2020, 2025): `latestScoringPeriod` ends up comfortably >= `finalScoringPeriod`
 * once a season is genuinely done (19 >= 16, 19 >= 16, 19 >= 17 respectively).
 */
function deriveSeasonStatus(
  season: number,
  weeksMeta: WeekMeta[],
  espnStatus: EspnSeasonStatus | undefined,
  warnings: string[],
): "upcoming" | "active" | "complete" {
  if (weeksMeta.length === 0) return "upcoming";
  if (!weeksMeta.every((w) => w.isComplete)) {
    return weeksMeta.some((w) => w.isComplete) ? "active" : "upcoming";
  }

  const latestScoringPeriod = asFiniteNumber(espnStatus?.latestScoringPeriod);
  const finalScoringPeriod = asFiniteNumber(espnStatus?.finalScoringPeriod);
  if (latestScoringPeriod !== undefined && finalScoringPeriod !== undefined) {
    if (latestScoringPeriod >= finalScoringPeriod) return "complete";
    warnings.push(
      `season ${season}: all ${weeksMeta.length} currently-recorded week(s) are complete, but ESPN's own status ` +
        `(latestScoringPeriod=${latestScoringPeriod} < finalScoringPeriod=${finalScoringPeriod}) shows the season ` +
        `isn't actually over yet — marked 'active', not 'complete' (playoff weeks likely not seeded as schedule ` +
        `entries yet)`,
    );
    return "active";
  }

  // Defensive only — every real archived season carries these fields (see docstring). Falls back
  // to the old "all recorded weeks complete" behavior rather than refusing to ever mark a season
  // complete, but flags that this could be premature for the same reason described above.
  warnings.push(
    `season ${season}: status.latestScoringPeriod/finalScoringPeriod missing from the season-scope payload — ` +
      `falling back to "all currently-recorded weeks complete" to derive status; could be premature if playoff ` +
      `weeks aren't recorded as schedule entries yet`,
  );
  return "complete";
}

function insertSeasonRow(
  tx: Db,
  season: number,
  leagueId: number,
  obj: EspnSeasonScopePayload,
  teamCount: number,
  weeksMeta: WeekMeta[],
  matchupPeriodCount: number | undefined,
  warnings: string[],
): void {
  // Confirmed reliable against every real archived season: prefer settings.scheduleSettings.
  // matchupPeriodCount when present; fall back to counting weekType='regular' weeks (which
  // itself now depends on real playoff-tier data merged in from weekly snapshots — see
  // computeWeeksMeta — rather than a field that never appears on the season-scope schedule).
  const regSeasonWeeks = matchupPeriodCount ?? weeksMeta.filter((w) => w.weekType === "regular").length;

  tx.insert(seasons)
    .values({
      season,
      leagueId,
      settingsJson: obj.settings ?? {},
      scoringJson: obj.settings?.scoringSettings ?? {},
      playoffFormatJson: obj.settings?.scheduleSettings ?? {},
      teamCount,
      regSeasonWeeks,
      status: deriveSeasonStatus(season, weeksMeta, obj.status, warnings),
    })
    .run();
}

// ---------------------------------------------------------------------------
// weeks (computed in-memory from `schedule[]`, independent of DB writes)
// ---------------------------------------------------------------------------

/** Groups `schedule` by `matchupPeriodId`, sorted ascending — shared by `computeWeeksMeta` and the pre-weekly-load week list. */
function groupScheduleByWeek(schedule: EspnScheduleEntry[], warnings: string[]): [number, EspnScheduleEntry[]][] {
  const byWeek = new Map<number, EspnScheduleEntry[]>();
  for (const entry of schedule) {
    const week = asFiniteNumber(entry.matchupPeriodId);
    if (week === undefined) {
      warnings.push(`schedule entry id=${String(entry.id)} missing numeric matchupPeriodId, excluded from weeks`);
      continue;
    }
    const list = byWeek.get(week) ?? [];
    list.push(entry);
    byWeek.set(week, list);
  }
  return [...byWeek.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * Distinct `matchupPeriodId`s present in the season-scope `schedule`,
 * ascending — just enough to know which weekly snapshots to load (identity
 * `scoringPeriodId` = week mapping). Split out from `computeWeeksMeta` so
 * loading weekly snapshots (needed to get real tier data) doesn't have to
 * happen AFTER `computeWeeksMeta`, which now itself needs those snapshots.
 */
function distinctWeekNumbers(schedule: EspnScheduleEntry[], warnings: string[]): number[] {
  return groupScheduleByWeek(schedule, warnings).map(([week]) => week);
}

/**
 * Builds an `entry.id -> playoffTierType` lookup from every loaded weekly
 * snapshot's `schedule[]`. Confirmed against real data that a single weekly
 * snapshot's schedule already covers the WHOLE season (not just its own
 * week) with tier data on every entry — but this still merges across every
 * snapshot we have (later weeks' data winning on a key collision) rather
 * than trusting just one, in case an early-season fetch had incomplete
 * bracket data before playoff seeding was finalized.
 */
function buildTierByEntryId(weeklyPayloads: Map<number, EspnWeekScopePayload>): Map<number, string> {
  const tierByEntryId = new Map<number, string>();
  for (const week of [...weeklyPayloads.keys()].sort((a, b) => a - b)) {
    const weekJson = weeklyPayloads.get(week)!;
    const schedule = Array.isArray(weekJson.schedule) ? weekJson.schedule : [];
    for (const entry of schedule) {
      const id = asFiniteNumber(entry.id);
      const tier = typeof entry.playoffTierType === "string" ? entry.playoffTierType : undefined;
      if (id !== undefined && tier !== undefined) {
        tierByEntryId.set(id, tier);
      }
    }
  }
  return tierByEntryId;
}

/** Tier for a season-scope schedule entry: weekly-derived map first, then the entry's own (season-scope) field as a defensive fallback (never populated in any real payload seen so far), else `undefined` ("we don't know"). */
function tierForEntry(entry: EspnScheduleEntry, tierByEntryId: Map<number, string>): string | undefined {
  const id = asFiniteNumber(entry.id);
  const fromWeekly = id !== undefined ? tierByEntryId.get(id) : undefined;
  if (fromWeekly !== undefined) return fromWeekly;
  return typeof entry.playoffTierType === "string" ? entry.playoffTierType : undefined;
}

/**
 * One `WeekMeta` per distinct `matchupPeriodId` in `schedule`.
 * `scoringPeriodId` = `matchupPeriodId` (identity mapping — "keep simple" per
 * the brief; multi-week playoff refinement is explicitly out of scope here).
 *
 * `weekType` prefers real tier data (`tierByEntryId`, merged in from weekly
 * snapshots — see `buildTierByEntryId`). When a week has NO tier data at all
 * (pre-2018 seasons: no weekly snapshots exist to have carried it), falls
 * back to `week > matchupPeriodCount => 'playoff'` when that count is known,
 * else defaults to 'regular' as an explicit last resort — either fallback
 * path is warned about, never silently guessed.
 */
function computeWeeksMeta(
  schedule: EspnScheduleEntry[],
  tierByEntryId: Map<number, string>,
  matchupPeriodCount: number | undefined,
  warnings: string[],
): WeekMeta[] {
  const result: WeekMeta[] = [];

  for (const [week, entries] of groupScheduleByWeek(schedule, warnings)) {
    const tiers = entries.map((e) => tierForEntry(e, tierByEntryId));

    let weekType: WeekType;
    if (tiers.every((t) => t === undefined)) {
      if (matchupPeriodCount !== undefined && week > matchupPeriodCount) {
        weekType = "playoff";
        warnings.push(
          `week ${week}: no playoff/tier data archived for this season; marked 'playoff' because week > ` +
            `settings.scheduleSettings.matchupPeriodCount (${matchupPeriodCount})`,
        );
      } else {
        weekType = "regular";
        if (matchupPeriodCount === undefined) {
          warnings.push(
            `week ${week}: no playoff/tier data archived and no matchupPeriodCount to infer from; defaulted to 'regular'`,
          );
        }
      }
    } else {
      const known = tiers.map((t) => t ?? "NONE");
      if (known.every((t) => t === "NONE")) weekType = "regular";
      else if (known.includes("WINNERS_BRACKET")) weekType = "playoff";
      else weekType = "consolation";
    }

    const isComplete = entries.every((e) => {
      if (!e.away) return true; // bye — nothing to decide
      return e.winner === "HOME" || e.winner === "AWAY" || e.winner === "TIE";
    });

    result.push({ week, scoringPeriodId: week, weekType, isComplete });
  }

  return result;
}

function insertWeeks(tx: Db, season: number, weeksMeta: WeekMeta[]): number {
  if (weeksMeta.length === 0) return 0;
  tx.insert(weeks)
    .values(
      weeksMeta.map((w) => ({
        season,
        week: w.week,
        scoringPeriodId: w.scoringPeriodId,
        weekType: w.weekType,
        isComplete: w.isComplete,
      })),
    )
    .run();
  return weeksMeta.length;
}

// ---------------------------------------------------------------------------
// team_seasons
// ---------------------------------------------------------------------------

interface ParsedTeam {
  espnTeamId: number;
  teamName: string;
  abbrev: string | null;
  logoUrl: string | null;
  divisionId: number | null;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  finalStanding: number | null;
  ownerSwids: string[];
}

function parseTeams(obj: EspnSeasonScopePayload, warnings: string[]): ParsedTeam[] {
  const teams: EspnTeam[] = Array.isArray(obj.teams) ? obj.teams : [];
  const out: ParsedTeam[] = [];

  for (const team of teams) {
    const espnTeamId = asFiniteNumber(team.id);
    if (espnTeamId === undefined) {
      warnings.push("team missing a numeric `id`, skipped");
      continue;
    }

    const nameFromParts = [asNonEmptyString(team.location), asNonEmptyString(team.nickname)]
      .filter((s): s is string => !!s)
      .join(" ")
      .trim();
    const teamName = asNonEmptyString(team.name) ?? (nameFromParts.length > 0 ? nameFromParts : `Team ${espnTeamId}`);

    const overall = team.record?.overall;
    const owners = Array.isArray(team.owners)
      ? team.owners.map(asOwnerSwid).filter((s): s is string => !!s)
      : [];

    out.push({
      espnTeamId,
      teamName,
      abbrev: asNonEmptyString(team.abbrev) ?? null,
      logoUrl: asNonEmptyString(team.logo) ?? null,
      divisionId: asFiniteNumber(team.divisionId) ?? null,
      wins: asFiniteNumber(overall?.wins) ?? 0,
      losses: asFiniteNumber(overall?.losses) ?? 0,
      ties: asFiniteNumber(overall?.ties) ?? 0,
      pointsFor: asFiniteNumber(overall?.pointsFor) ?? 0,
      pointsAgainst: asFiniteNumber(overall?.pointsAgainst) ?? 0,
      finalStanding: asFiniteNumber(team.rankCalculatedFinal) ?? null,
      ownerSwids: owners,
    });
  }

  return out;
}

/** Teams appearing in ANY `WINNERS_BRACKET` schedule entry this season — our `madePlayoffs` proxy. */
function teamsInWinnersBracket(schedule: EspnScheduleEntry[], tierByEntryId: Map<number, string>): Set<number> {
  const set = new Set<number>();
  for (const entry of schedule) {
    if (tierForEntry(entry, tierByEntryId) !== "WINNERS_BRACKET") continue;
    const home = asFiniteNumber(entry.home?.teamId);
    if (home !== undefined) set.add(home);
    if (entry.away) {
      const away = asFiniteNumber(entry.away.teamId);
      if (away !== undefined) set.add(away);
    }
  }
  return set;
}

/** Caller MUST have already confirmed every team resolves (see the unmapped-team hard-fail check). */
function insertTeamSeasons(
  tx: Db,
  season: number,
  parsedTeams: ParsedTeam[],
  franchiseSeed: FranchiseSeed,
  playoffTeamIds: Set<number>,
): Map<number, number> {
  const teamSeasonIdByEspnId = new Map<number, number>();

  for (const team of parsedTeams) {
    const franchiseId = resolveFranchise(franchiseSeed, season, team.espnTeamId, team.ownerSwids);
    if (franchiseId === null) {
      // Unreachable in practice — normalizeSeason checks this for every team before opening the
      // transaction. Guard kept so a future refactor can't silently write a bad FK.
      throw new Error(`internal error: team ${team.espnTeamId} resolved to no franchise inside the write transaction`);
    }

    const row = tx
      .insert(teamSeasons)
      .values({
        season,
        franchiseId,
        espnTeamId: team.espnTeamId,
        teamName: team.teamName,
        abbrev: team.abbrev,
        logoUrl: team.logoUrl,
        divisionId: team.divisionId,
        wins: team.wins,
        losses: team.losses,
        ties: team.ties,
        pointsFor: team.pointsFor,
        pointsAgainst: team.pointsAgainst,
        finalStanding: team.finalStanding,
        madePlayoffs: playoffTeamIds.has(team.espnTeamId),
      })
      .returning({ id: teamSeasons.id })
      .get();

    teamSeasonIdByEspnId.set(team.espnTeamId, row.id);
  }

  return teamSeasonIdByEspnId;
}

// ---------------------------------------------------------------------------
// matchups
// ---------------------------------------------------------------------------

function buildMatchupRows(
  season: number,
  schedule: EspnScheduleEntry[],
  teamSeasonIdByEspnId: Map<number, number>,
  tierByEntryId: Map<number, string>,
  warnings: string[],
): NewMatchup[] {
  const rows: NewMatchup[] = [];

  for (const entry of schedule) {
    const espnMatchupId = asFiniteNumber(entry.id);
    const week = asFiniteNumber(entry.matchupPeriodId);
    const homeTeamId = asFiniteNumber(entry.home?.teamId);
    if (espnMatchupId === undefined || week === undefined || homeTeamId === undefined) {
      warnings.push(`schedule entry missing id/matchupPeriodId/home.teamId, skipped (id=${String(entry.id)})`);
      continue;
    }

    const homeTeamSeasonId = teamSeasonIdByEspnId.get(homeTeamId);
    if (homeTeamSeasonId === undefined) {
      warnings.push(`matchup ${espnMatchupId}: home teamId ${homeTeamId} has no team_season row, skipped`);
      continue;
    }
    const homeScore = asFiniteNumber(entry.home?.totalPoints) ?? 0;

    let awayTeamSeasonId: number | null = null;
    let awayScore = 0;
    if (entry.away) {
      const awayTeamId = asFiniteNumber(entry.away.teamId);
      if (awayTeamId === undefined) {
        warnings.push(`matchup ${espnMatchupId}: away side present but missing teamId, treated as a bye`);
      } else {
        const resolved = teamSeasonIdByEspnId.get(awayTeamId);
        if (resolved === undefined) {
          warnings.push(`matchup ${espnMatchupId}: away teamId ${awayTeamId} has no team_season row, treated as a bye`);
        } else {
          awayTeamSeasonId = resolved;
          awayScore = asFiniteNumber(entry.away.totalPoints) ?? 0;
        }
      }
    }

    let winner: "home" | "away" | "tie" | null = null;
    let isFinal: boolean;
    if (awayTeamSeasonId === null) {
      isFinal = true; // bye — nothing pending
    } else {
      if (entry.winner === "HOME") winner = "home";
      else if (entry.winner === "AWAY") winner = "away";
      else if (entry.winner === "TIE") winner = "tie";
      isFinal = winner !== null;
    }

    rows.push({
      season,
      week,
      espnMatchupId,
      homeTeamSeasonId,
      awayTeamSeasonId,
      homeScore,
      awayScore,
      // TODO(stats layer): derive from summed starters' roster_slots.projectedPoints once that's
      // available — the brief's mapping rules don't specify a matchup-level projection source.
      homeProjected: null,
      awayProjected: null,
      playoffTier: tierForEntry(entry, tierByEntryId) ?? null,
      // TODO: multi-week playoff group refinement — explicitly deferred, see brief.
      multiWeekGroup: null,
      isFinal,
      winner,
    });
  }

  return rows;
}

function insertMatchups(
  tx: Db,
  season: number,
  schedule: EspnScheduleEntry[],
  teamSeasonIdByEspnId: Map<number, number>,
  tierByEntryId: Map<number, string>,
  warnings: string[],
): number {
  const rows = buildMatchupRows(season, schedule, teamSeasonIdByEspnId, tierByEntryId, warnings);
  if (rows.length === 0) return 0;
  tx.insert(matchups).values(rows).run();
  return rows.length;
}

// ---------------------------------------------------------------------------
// players + roster_slots (from weekly snapshots)
// ---------------------------------------------------------------------------

interface ParsedPlayerMeta {
  espnPlayerId: number;
  fullName: string;
  defaultPosition: string;
  proTeam: string | null;
}

function parsePlayerMeta(player: EspnPlayer | undefined, warnings: string[]): ParsedPlayerMeta | null {
  const espnPlayerId = asFiniteNumber(player?.id);
  if (espnPlayerId === undefined) return null;

  const fullName = asNonEmptyString(player?.fullName) ?? `Unknown Player ${espnPlayerId}`;

  const positionId = asFiniteNumber(player?.defaultPositionId);
  let defaultPosition: string;
  if (positionId === undefined) {
    defaultPosition = "UNK";
  } else {
    const mapped = POSITION_MAP[positionId];
    if (mapped === undefined) {
      warnings.push(`player ${espnPlayerId}: unmapped defaultPositionId ${positionId}`);
      defaultPosition = `POS_${positionId}`;
    } else {
      defaultPosition = mapped;
    }
  }

  const proTeamId = asFiniteNumber(player?.proTeamId);
  let proTeam: string | null = null;
  if (proTeamId !== undefined) {
    const mapped = PRO_TEAM_MAP[proTeamId];
    if (mapped === undefined) {
      warnings.push(`player ${espnPlayerId}: unmapped proTeamId ${proTeamId}`);
    } else {
      proTeam = mapped;
    }
  }

  return { espnPlayerId, fullName, defaultPosition, proTeam };
}

/** Labels a `lineupSlotId`/`eligibleSlots` entry via `LINEUP_SLOT_MAP`; unknown/empty -> `SLOT_<id>` + warning. */
function slotLabel(slotId: number, warnings: string[], context: string): string {
  const label = LINEUP_SLOT_MAP[slotId];
  if (label === undefined || label === "") {
    warnings.push(`${context}: unmapped lineupSlotId ${slotId}`);
    return `SLOT_${slotId}`;
  }
  return label;
}

function findProjectedPoints(player: EspnPlayer | undefined, week: number): number | null {
  const stats = Array.isArray(player?.stats) ? player.stats : [];
  for (const s of stats) {
    if (asFiniteNumber(s.scoringPeriodId) === week && asFiniteNumber(s.statSourceId) === 1) {
      return asFiniteNumber(s.appliedTotal) ?? null;
    }
  }
  return null;
}

interface RosterSlotCandidate {
  espnTeamId: number;
  week: number;
  playerId: number;
  lineupSlot: string;
  isStarter: boolean;
  points: number | null;
  projectedPoints: number | null;
  eligibleSlotsJson: string[];
}

/** BE(20)/IR(21) — the only slot ids the brief specifies as non-starting. */
const BENCH_SLOT_IDS = new Set([20, 21]);

function parseWeeklyRoster(
  week: number,
  weekJson: EspnWeekScopePayload,
  playersOut: Map<number, ParsedPlayerMeta>,
  warnings: string[],
): RosterSlotCandidate[] {
  const out: RosterSlotCandidate[] = [];
  const schedule = Array.isArray(weekJson.schedule) ? weekJson.schedule : [];

  for (const entry of schedule) {
    for (const side of [entry.home, entry.away]) {
      if (!side) continue;
      const espnTeamId = asFiniteNumber(side.teamId);
      if (espnTeamId === undefined) continue;

      const rosterEntries = Array.isArray(side.rosterForCurrentScoringPeriod?.entries)
        ? side.rosterForCurrentScoringPeriod!.entries!
        : [];

      for (const rEntry of rosterEntries) {
        const ppe = rEntry.playerPoolEntry;
        const playerId = asFiniteNumber(ppe?.player?.id) ?? asFiniteNumber(ppe?.id);
        if (playerId === undefined) {
          warnings.push(`week ${week} team ${espnTeamId}: roster entry missing a player id, skipped`);
          continue;
        }

        const meta = parsePlayerMeta(ppe?.player, warnings);
        if (meta) playersOut.set(meta.espnPlayerId, meta);

        const context = `week ${week} team ${espnTeamId} player ${playerId}`;
        const slotId = asFiniteNumber(rEntry.lineupSlotId);
        let lineupSlot: string;
        let isStarter: boolean;
        if (slotId === undefined) {
          warnings.push(`${context}: missing lineupSlotId, defaulting to non-starter`);
          lineupSlot = "UNKNOWN";
          isStarter = false;
        } else {
          lineupSlot = slotLabel(slotId, warnings, context);
          isStarter = !BENCH_SLOT_IDS.has(slotId);
        }

        const eligibleSlotsRaw = Array.isArray(ppe?.player?.eligibleSlots) ? ppe!.player!.eligibleSlots! : [];
        const eligibleSlotsJson = (eligibleSlotsRaw as unknown[])
          .map(asFiniteNumber)
          .filter((id): id is number => id !== undefined)
          .map((id) => slotLabel(id, warnings, `${context} eligibleSlots`));

        out.push({
          espnTeamId,
          week,
          playerId,
          lineupSlot,
          isStarter,
          points: asFiniteNumber(ppe?.appliedStatTotal) ?? null,
          projectedPoints: findProjectedPoints(ppe?.player, week),
          eligibleSlotsJson,
        });
      }
    }
  }

  return out;
}

/** `scoringPeriodId` = `week` (identity mapping — see `computeWeeksMeta`'s docstring). */
function loadWeeklyPayloads(
  db: Db,
  season: number,
  weekNumbers: number[],
  warnings: string[],
): Map<number, EspnWeekScopePayload> {
  const out = new Map<number, EspnWeekScopePayload>();

  for (const week of weekNumbers) {
    const snap = getLatestSnapshot(db, { season, view: WEEK_SCOPE_VIEW_KEY, scoringPeriod: week });
    if (!snap) {
      warnings.push(
        `week ${week}: no weekly snapshot archived (view "${WEEK_SCOPE_VIEW_KEY}", period ${week}) — ` +
          `roster/boxscore/tier data unavailable for this week`,
      );
      continue;
    }
    try {
      out.set(week, JSON.parse(snap.payload) as EspnWeekScopePayload);
    } catch (err) {
      warnings.push(
        `week ${week}: weekly snapshot payload did not parse as JSON, skipped (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  return out;
}

/**
 * Aggregates every archived per-period `mTransactions2` snapshot for this
 * season (whichever periods actually have one — not assumed to line up with
 * `weekNumbers`/matchup periods), plus `obj.transactions` (season-scope,
 * kept as a fallback source per the brief — empty in every real payload
 * seen so far). Deduped by ESPN transaction id: a transaction can
 * legitimately appear in more than one period's response, and the schema's
 * `UNIQUE (season, espn_tx_id)` is only the backstop, not the primary
 * dedupe mechanism (re-inserting a duplicate would throw). Periods are
 * processed ascending, later periods' copy winning a collision (read as
 * "the most recently fetched view of this transaction" — plausible source
 * of divergence being a status transition, e.g. PENDING -> EXECUTED).
 */
function loadAndMergeTransactions(
  db: Db,
  season: number,
  obj: EspnSeasonScopePayload,
  warnings: string[],
): EspnTransaction[] {
  const byId = new Map<string, EspnTransaction>();
  let duplicateCount = 0;

  const periods = periodsWithSnapshot(db, season, TRANSACTIONS_VIEW_KEY);
  for (const period of periods) {
    const snap = getLatestSnapshot(db, { season, view: TRANSACTIONS_VIEW_KEY, scoringPeriod: period });
    if (!snap) continue; // periodsWithSnapshot just confirmed one exists; defensive only

    let payload: EspnTransactionsPayload;
    try {
      payload = JSON.parse(snap.payload) as EspnTransactionsPayload;
    } catch (err) {
      warnings.push(
        `transactions period ${period}: payload did not parse as JSON, skipped (${err instanceof Error ? err.message : String(err)})`,
      );
      continue;
    }

    for (const t of Array.isArray(payload.transactions) ? payload.transactions : []) {
      const id = t.id === undefined || t.id === null ? undefined : String(t.id);
      if (id === undefined) continue; // no id to dedupe/insert by — insertTransactions warns individually
      if (byId.has(id)) duplicateCount++;
      byId.set(id, t);
    }
  }

  // Season-scope fallback: only fills gaps (per-period wins on a collision) — see docstring.
  for (const t of Array.isArray(obj.transactions) ? obj.transactions : []) {
    const id = t.id === undefined || t.id === null ? undefined : String(t.id);
    if (id === undefined || byId.has(id)) continue;
    byId.set(id, t);
  }

  if (duplicateCount > 0) {
    warnings.push(`season ${season}: ${duplicateCount} transaction(s) appeared in more than one period's snapshot, deduped`);
  }

  return [...byId.values()];
}

function upsertPlayers(tx: Db, metaById: Map<number, ParsedPlayerMeta>, placeholderIds: Set<number>): number {
  let count = 0;

  for (const meta of metaById.values()) {
    tx.insert(players)
      .values({
        espnPlayerId: meta.espnPlayerId,
        fullName: meta.fullName,
        defaultPosition: meta.defaultPosition,
        proTeam: meta.proTeam,
      })
      .onConflictDoUpdate({
        target: players.espnPlayerId,
        set: { fullName: meta.fullName, defaultPosition: meta.defaultPosition, proTeam: meta.proTeam },
      })
      .run();
    count++;
  }

  for (const id of placeholderIds) {
    // onConflictDoNothing: a placeholder (id-only, from a draft pick/transaction with no roster
    // data) must NEVER clobber a real player row from this run or an earlier normalize.
    tx.insert(players)
      .values({ espnPlayerId: id, fullName: `Unknown Player ${id}`, defaultPosition: "UNK", proTeam: null })
      .onConflictDoNothing({ target: players.espnPlayerId })
      .run();
    count++;
  }

  return count;
}

function insertRosterSlots(
  tx: Db,
  season: number,
  candidates: RosterSlotCandidate[],
  teamSeasonIdByEspnId: Map<number, number>,
  warnings: string[],
): number {
  const rows: NewRosterSlot[] = [];
  const seen = new Set<string>();

  for (const c of candidates) {
    const teamSeasonId = teamSeasonIdByEspnId.get(c.espnTeamId);
    if (teamSeasonId === undefined) {
      warnings.push(`week ${c.week}: roster entry for espnTeamId ${c.espnTeamId} has no team_season row, skipped`);
      continue;
    }
    const key = `${c.week}:${teamSeasonId}:${c.playerId}`;
    if (seen.has(key)) {
      warnings.push(`week ${c.week} team_season ${teamSeasonId} player ${c.playerId}: duplicate roster entry, kept first`);
      continue;
    }
    seen.add(key);

    rows.push({
      season,
      week: c.week,
      teamSeasonId,
      playerId: c.playerId,
      lineupSlot: c.lineupSlot,
      isStarter: c.isStarter,
      points: c.points,
      projectedPoints: c.projectedPoints,
      eligibleSlotsJson: c.eligibleSlotsJson,
    });
  }

  if (rows.length === 0) return 0;
  tx.insert(rosterSlots).values(rows).run();
  return rows.length;
}

// ---------------------------------------------------------------------------
// transactions + transaction_items
// ---------------------------------------------------------------------------

interface TransactionClassification {
  /** `null` means "don't create a `transactions` row for this" — see `skipReason`. */
  type: Transaction["type"] | null;
  skipReason?: string;
}

/**
 * Decides whether an ESPN transaction becomes a normalized `transactions`
 * row, per the brief's decision (verified against real live-probed data,
 * Task 7): DRAFT is never mapped (already captured via `draftDetail.picks`
 * -> `draft_picks`); FUTURE_ROSTER is never mapped (pure lineup management
 * for a future period — every real example seen has LINEUP-only items, not
 * a roster move); everything else only counts when `status === "EXECUTED"`
 * (the one status value confirmed reliable across every type — PENDING/
 * CANCELED/FAILED_* all excluded by this single check). ROSTER additionally
 * requires at least one ADD/DROP/TRADE item ("ROSTER-with-adds-drops" per
 * the brief) — a ROSTER transaction with only LINEUP items is pure bench
 * management, not a roster move, same reasoning as FUTURE_ROSTER.
 */
function classifyTransaction(t: EspnTransaction): TransactionClassification {
  const type = typeof t.type === "string" ? t.type.toUpperCase() : undefined;

  if (type === "DRAFT") return { type: null, skipReason: "DRAFT (already captured via draft_picks)" };
  if (type === "FUTURE_ROSTER") return { type: null, skipReason: "FUTURE_ROSTER (future-period lineup management)" };
  if (t.status !== "EXECUTED") return { type: null, skipReason: `not executed (status=${JSON.stringify(t.status)})` };

  if (type === "WAIVER") return { type: "waiver" };
  if (type === "FREEAGENT") return { type: "freeagent" };
  if (type === "TRADE_ACCEPT" || type === "TRADE_UPHOLD" || type === "TRADE_PROPOSAL") return { type: "trade" };
  if (type === "ROSTER") {
    const items = Array.isArray(t.items) ? t.items : [];
    const hasRosterMove = items.some((i) => {
      const itemType = typeof i.type === "string" ? i.type.toUpperCase() : undefined;
      return itemType === "ADD" || itemType === "DROP" || itemType === "TRADE";
    });
    return hasRosterMove ? { type: "drop" } : { type: null, skipReason: "ROSTER with no add/drop/trade items" };
  }

  return { type: null, skipReason: `unrecognized type ${JSON.stringify(t.type)}` };
}

interface ItemAction {
  action: TransactionItem["action"];
  espnTeamId: number;
}

/**
 * A real `TRADE` item (confirmed by live probe) carries BOTH a real
 * `fromTeamId` and `toTeamId` in ONE object — unlike ADD/DROP, where one
 * side is always `0` (the free-agent pool). Since `transaction_items` is
 * one (teamSeasonId, action) pair per row, a single TRADE item becomes TWO
 * rows: the sending team's `trade_away` and the receiving team's
 * `trade_for`. ADD/DROP items inside a `trade`-classified transaction
 * (unexpected in practice, but defensively handled) map the same way a
 * lone leg of a trade would. Outside a trade, ADD/DROP map directly.
 * Anything else (`LINEUP`, `DRAFT`, ...) isn't representable here.
 */
function buildItemActions(
  txType: Transaction["type"],
  itemType: string,
  fromTeamId: number | undefined,
  toTeamId: number | undefined,
): ItemAction[] {
  if (txType === "trade") {
    if (itemType === "TRADE") {
      const out: ItemAction[] = [];
      if (fromTeamId !== undefined) out.push({ action: "trade_away", espnTeamId: fromTeamId });
      if (toTeamId !== undefined) out.push({ action: "trade_for", espnTeamId: toTeamId });
      return out;
    }
    if (itemType === "ADD" && toTeamId !== undefined) return [{ action: "trade_for", espnTeamId: toTeamId }];
    if (itemType === "DROP" && fromTeamId !== undefined) return [{ action: "trade_away", espnTeamId: fromTeamId }];
    return [];
  }
  if (itemType === "ADD" && toTeamId !== undefined) return [{ action: "add", espnTeamId: toTeamId }];
  if (itemType === "DROP" && fromTeamId !== undefined) return [{ action: "drop", espnTeamId: fromTeamId }];
  return [];
}

function insertTransactions(
  tx: Db,
  season: number,
  txs: EspnTransaction[],
  teamSeasonIdByEspnId: Map<number, number>,
  warnings: string[],
): { transactions: number; items: number } {
  let txCount = 0;
  let itemCount = 0;
  const skipCounts = new Map<string, number>();

  for (const t of txs) {
    if (t.id === undefined || t.id === null) {
      warnings.push("transaction missing id, skipped");
      continue;
    }
    const espnTxId = String(t.id);

    const classification = classifyTransaction(t);
    if (!classification.type) {
      const reason = classification.skipReason ?? "unclassified";
      skipCounts.set(reason, (skipCounts.get(reason) ?? 0) + 1);
      continue;
    }
    const type = classification.type;

    const proposedAt = asFiniteNumber(t.proposedDate);
    const processedAt = asFiniteNumber(t.processDate) ?? asFiniteNumber(t.executionDate);

    const row = tx
      .insert(transactions)
      .values({
        season,
        espnTxId,
        type,
        status: asNonEmptyString(t.status) ?? "UNKNOWN",
        bidAmount: asFiniteNumber(t.bidAmount) ?? null,
        proposedAt: proposedAt !== undefined ? new Date(proposedAt) : null,
        processedAt: processedAt !== undefined ? new Date(processedAt) : null,
        rawJson: t,
      })
      .returning({ id: transactions.id })
      .get();
    txCount++;

    for (const item of t.items ?? []) {
      const playerId = asFiniteNumber(item.playerId);
      const itemType = typeof item.type === "string" ? item.type.toUpperCase() : undefined;
      if (playerId === undefined || !itemType) {
        warnings.push(`transaction ${espnTxId}: item missing playerId/type, skipped`);
        continue;
      }

      const actions = buildItemActions(type, itemType, asFiniteNumber(item.fromTeamId), asFiniteNumber(item.toTeamId));
      if (actions.length === 0) {
        warnings.push(`transaction ${espnTxId}: item type "${itemType}" isn't representable as a transaction_item action, skipped`);
        continue;
      }

      for (const { action, espnTeamId } of actions) {
        const teamSeasonId = teamSeasonIdByEspnId.get(espnTeamId);
        if (teamSeasonId === undefined) {
          warnings.push(`transaction ${espnTxId}: item team ${espnTeamId} has no team_season row, skipped`);
          continue;
        }
        tx.insert(transactionItems).values({ transactionId: row.id, teamSeasonId, playerId, action, source: "espn" }).run();
        itemCount++;
      }
    }
  }

  // One aggregated line, not one warning per skipped transaction — a real season's per-period
  // transactions are overwhelmingly DRAFT/FUTURE_ROSTER/unexecuted noise (e.g. 192/223 DRAFT
  // alone in one real 2024 period), and warning-flooding that would bury the signal.
  if (skipCounts.size > 0) {
    const total = [...skipCounts.values()].reduce((a, b) => a + b, 0);
    const breakdown = [...skipCounts.entries()].map(([reason, n]) => `${n} ${reason}`).join("; ");
    warnings.push(`season ${season}: ${total} transaction(s) not mapped into normalized rows (${breakdown})`);
  }

  return { transactions: txCount, items: itemCount };
}

const TRADE_RECORD_TYPES = new Set(["TRADE_PROPOSAL", "TRADE_ACCEPT", "TRADE_UPHOLD", "TRADE_VETO", "TRADE_DECLINE"]);
const TRADE_ANCHOR_TYPES = new Set(["TRADE_PROPOSAL", "TRADE_ACCEPT"]);

export interface RecoveredTradeClaim extends GroupClaim {
  scoringPeriod: number;
}

export function resolveRecoveredTradeClaims(claims: readonly RecoveredTradeClaim[]): Map<string, InferredTradeItem[]> {
  const claimsByPeriod = new Map<number, RecoveredTradeClaim[]>();
  for (const claim of claims) {
    const periodClaims = claimsByPeriod.get(claim.scoringPeriod);
    if (periodClaims) periodClaims.push(claim);
    else claimsByPeriod.set(claim.scoringPeriod, [claim]);
  }

  const keptByGroup = new Map<string, InferredTradeItem[]>();
  for (const periodClaims of claimsByPeriod.values()) {
    const periodResolution = resolveCrossGroupClaims(periodClaims);
    for (const claim of periodClaims) keptByGroup.set(claim.key, periodResolution.keptByGroup.get(claim.key) ?? []);
  }
  return keptByGroup;
}

function tradeGroupKey(transaction: EspnTransaction): string | null {
  const related = transaction.relatedTransactionId;
  if (related !== undefined && related !== null) return String(related);
  if (transaction.id !== undefined && transaction.id !== null) return String(transaction.id);
  return null;
}

function hasIndependentMove(
  tx: Db,
  canonicalTransactionId: number,
  playerId: number,
  teamSeasonId: number,
  actions: readonly TransactionItem["action"][],
): boolean {
  return tx
    .select({ id: transactionItems.id })
    .from(transactionItems)
    .where(
      and(
        eq(transactionItems.playerId, playerId),
        eq(transactionItems.teamSeasonId, teamSeasonId),
        inArray(transactionItems.action, actions),
        sql`${transactionItems.transactionId} <> ${canonicalTransactionId}`,
      ),
    )
    .limit(1)
    .get() !== undefined;
}

function recoverItemlessTrades(
  tx: Db,
  season: number,
  rawTransactions: EspnTransaction[],
  teamSeasonIdByEspnId: Map<number, number>,
  warnings: string[],
): number {
  const orphanRows = tx
    .select({ id: transactions.id, espnTxId: transactions.espnTxId })
    .from(transactions)
    .leftJoin(transactionItems, eq(transactionItems.transactionId, transactions.id))
    .where(and(eq(transactions.season, season), eq(transactions.type, "trade"), isNull(transactionItems.id)))
    .all();
  if (orphanRows.length === 0) return 0;

  const rawById = new Map<string, EspnTransaction>();
  for (const raw of rawTransactions) {
    if (raw.id !== undefined && raw.id !== null) rawById.set(String(raw.id), raw);
  }

  const rowsByGroup = new Map<string, typeof orphanRows>();
  for (const row of orphanRows) {
    const raw = rawById.get(row.espnTxId);
    const key = raw ? tradeGroupKey(raw) : null;
    if (!key) continue;
    const rows = rowsByGroup.get(key);
    if (rows) rows.push(row);
    else rowsByGroup.set(key, [row]);
  }

  const coveredPeriods = new Set(periodsWithSnapshot(tx, season, TRANSACTIONS_VIEW_KEY));
  const contexts: Array<{
    groupKey: string;
    scoringPeriod: number;
    canonicalTransactionId: number;
    inferred: InferredTradeItem[];
    anchorTeamSeasonIds: ReadonlySet<number>;
  }> = [];

  for (const [groupKey, groupRows] of rowsByGroup) {
    const related = rawTransactions.filter((raw) => {
      const id = raw.id === undefined || raw.id === null ? null : String(raw.id);
      return id === groupKey || tradeGroupKey(raw) === groupKey;
    });
    if (related.some((raw) => Array.isArray(raw.items) && raw.items.length > 0)) continue;

    const weeks = new Set(related.map((raw) => asFiniteNumber(raw.scoringPeriodId)).filter((week): week is number => week !== undefined));
    if (weeks.size !== 1) {
      warnings.push(`season ${season}: recovered trade group ${groupKey} has no single scoring period; left incomplete`);
      continue;
    }
    const week = [...weeks][0]!;
    if (week <= 1 || !coveredPeriods.has(week - 1) || !coveredPeriods.has(week)) {
      warnings.push(`season ${season}: recovered trade group ${groupKey} lacks complete adjacent transaction snapshots; roster inference skipped`);
      continue;
    }

    const candidateEspnTeamIds = new Set<number>();
    const anchorTeamSeasonIds = new Set<number>();
    for (const raw of related) {
      const type = typeof raw.type === "string" ? raw.type.toUpperCase() : null;
      const espnTeamId = asFiniteNumber(raw.teamId);
      if (espnTeamId === undefined || (type !== null && !TRADE_RECORD_TYPES.has(type))) continue;
      candidateEspnTeamIds.add(espnTeamId);
      if (type !== null && TRADE_ANCHOR_TYPES.has(type)) {
        const teamSeasonId = teamSeasonIdByEspnId.get(espnTeamId);
        if (teamSeasonId !== undefined) anchorTeamSeasonIds.add(teamSeasonId);
      }
    }
    const candidateTeamSeasonIds = [...candidateEspnTeamIds]
      .map((espnTeamId) => teamSeasonIdByEspnId.get(espnTeamId))
      .filter((teamSeasonId): teamSeasonId is number => teamSeasonId !== undefined);
    if (candidateTeamSeasonIds.length < 2) {
      warnings.push(`season ${season}: recovered trade group ${groupKey} has fewer than two resolvable candidate teams; left incomplete`);
      continue;
    }

    const before: RosterEntry[] = tx
      .select({ teamSeasonId: rosterSlots.teamSeasonId, playerId: rosterSlots.playerId })
      .from(rosterSlots)
      .where(and(eq(rosterSlots.season, season), eq(rosterSlots.week, week - 1), inArray(rosterSlots.teamSeasonId, candidateTeamSeasonIds)))
      .all();
    const after: RosterEntry[] = tx
      .select({ teamSeasonId: rosterSlots.teamSeasonId, playerId: rosterSlots.playerId })
      .from(rosterSlots)
      .where(and(eq(rosterSlots.season, season), eq(rosterSlots.week, week), inArray(rosterSlots.teamSeasonId, candidateTeamSeasonIds)))
      .all();

    const canonical = groupRows.reduce((lowest, row) => row.id < lowest.id ? row : lowest, groupRows[0]!);
    const inferred: InferredTradeItem[] = inferTradeItemsFromRosterDiff(before, after).filter((item) => {
      const departureExplained = hasIndependentMove(tx, canonical.id, item.playerId, item.fromTeamSeasonId, ["drop", "trade_away"]);
      const arrivalExplained = hasIndependentMove(tx, canonical.id, item.playerId, item.toTeamSeasonId, ["add", "trade_for"]);
      return !(departureExplained && arrivalExplained);
    });
    if (inferred.length === 0) {
      warnings.push(`season ${season}: recovered trade group ${groupKey} had no defensible roster exchange; left incomplete`);
      continue;
    }

    contexts.push({ groupKey, scoringPeriod: week, canonicalTransactionId: canonical.id, inferred, anchorTeamSeasonIds });
  }

  const resolvedByGroup = resolveRecoveredTradeClaims(
    contexts.map((context) => ({
      key: context.groupKey,
      scoringPeriod: context.scoringPeriod,
      items: context.inferred,
      anchorTeamSeasonIds: context.anchorTeamSeasonIds,
    })),
  );
  let inserted = 0;

  for (const context of contexts) {
    let inferred = resolvedByGroup.get(context.groupKey) ?? [];
    inferred = keepDominantComponent(excludeLoneLegs(inferred), context.anchorTeamSeasonIds);
    inferred = keepDominantBlock(inferred, context.anchorTeamSeasonIds);
    if (inferred.length === 0) {
      warnings.push(`season ${season}: recovered trade group ${context.groupKey} lost every contested or structurally unsupported move; left incomplete`);
      continue;
    }

    for (const item of inferred) {
      tx.insert(transactionItems)
        .values({ transactionId: context.canonicalTransactionId, teamSeasonId: item.fromTeamSeasonId, playerId: item.playerId, action: "trade_away", source: "inferred" })
        .run();
      tx.insert(transactionItems)
        .values({ transactionId: context.canonicalTransactionId, teamSeasonId: item.toTeamSeasonId, playerId: item.playerId, action: "trade_for", source: "inferred" })
        .run();
      inserted += 2;
    }
  }

  return inserted;
}

// ---------------------------------------------------------------------------
// draft_picks
// ---------------------------------------------------------------------------

function insertDraftPicks(
  tx: Db,
  season: number,
  picks: EspnDraftPick[],
  teamSeasonIdByEspnId: Map<number, number>,
  warnings: string[],
): number {
  const rows: NewDraftPick[] = [];

  for (const p of picks) {
    const round = asFiniteNumber(p.roundId);
    const roundPick = asFiniteNumber(p.roundPickNumber);
    const overallPick = asFiniteNumber(p.overallPickNumber);
    const playerId = asFiniteNumber(p.playerId);
    const espnTeamId = asFiniteNumber(p.teamId);

    if (round === undefined || roundPick === undefined || overallPick === undefined || playerId === undefined || espnTeamId === undefined) {
      warnings.push(`draft pick missing a required field (round/roundPick/overallPick/playerId/teamId), skipped`);
      continue;
    }
    const teamSeasonId = teamSeasonIdByEspnId.get(espnTeamId);
    if (teamSeasonId === undefined) {
      warnings.push(`draft pick overall=${overallPick}: teamId ${espnTeamId} has no team_season row, skipped`);
      continue;
    }

    rows.push({
      season,
      round,
      roundPick,
      overallPick,
      teamSeasonId,
      playerId,
      keeper: typeof p.keeper === "boolean" ? p.keeper : false,
      auctionAmount: asFiniteNumber(p.bidAmount) ?? null,
    });
  }

  if (rows.length === 0) return 0;
  tx.insert(draftPicks).values(rows).run();
  return rows.length;
}
