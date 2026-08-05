import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { beltMatches, beltReigns, franchises } from "../db/schema";

export interface BeltHolder {
  franchiseId: number;
  franchiseName: string;
  defenses: number;
  reignNo: number;
}

/**
 * The current belt reign (belt_reigns.is_current), joined to the holding
 * franchise. Returns null in the graceful-empty-state case (no is_current
 * row — e.g. a brand new league before the first belt is won).
 */
export function getCurrentBeltHolder(): BeltHolder | null {
  const db = getDb();
  const row = db
    .select({
      franchiseId: franchises.id,
      franchiseName: franchises.canonicalName,
      defenses: beltReigns.defenses,
      reignNo: beltReigns.reignNo,
    })
    .from(beltReigns)
    .innerJoin(franchises, eq(beltReigns.franchiseId, franchises.id))
    .where(eq(beltReigns.isCurrent, true))
    .get();

  return row ?? null;
}

// ---------------------------------------------------------------------------
// /belt — full lineage, records strip, current-reign hero
// ---------------------------------------------------------------------------

export interface BeltLineageRow {
  reignNo: number;
  holderId: number;
  holderName: string;
  wonFromName: string | null;
  startSeason: number;
  startWeek: number;
  endSeason: number | null;
  endWeek: number | null;
  defenses: number;
  weeksHeld: number;
  endReason: "lost" | "vacated" | "override" | null;
  isCurrent: boolean;
}

/** Every reign in league history, most recent first. */
export function getBeltLineage(): BeltLineageRow[] {
  const db = getDb();
  const reigns = db.select().from(beltReigns).orderBy(desc(beltReigns.reignNo)).all();
  const franchiseRows = db.select({ id: franchises.id, name: franchises.canonicalName }).from(franchises).all();
  const nameById = new Map(franchiseRows.map((f) => [f.id, f.name]));
  const nameOf = (id: number) => nameById.get(id) ?? `Franchise ${id}`;

  return reigns.map((r) => ({
    reignNo: r.reignNo,
    holderId: r.franchiseId,
    holderName: nameOf(r.franchiseId),
    wonFromName: r.wonFromFranchiseId !== null ? nameOf(r.wonFromFranchiseId) : null,
    startSeason: r.startSeason,
    startWeek: r.startWeek,
    endSeason: r.endSeason,
    endWeek: r.endWeek,
    defenses: r.defenses,
    weeksHeld: r.weeksHeld,
    endReason: r.endReason,
    isCurrent: r.isCurrent,
  }));
}

export interface BeltRecordsIds {
  mostReigns: { franchiseId: number; count: number } | null;
  longestReign: { franchiseId: number; weeksHeld: number; startSeason: number; startWeek: number } | null;
  mostDefenses: { franchiseId: number; defenses: number } | null;
}

/** Reign-count/weeks-held/defenses leaders across all reigns. Pure — unit-tested directly. */
export function computeBeltRecords(
  reigns: { franchiseId: number; weeksHeld: number; defenses: number; startSeason: number; startWeek: number }[],
): BeltRecordsIds {
  const countByFranchise = new Map<number, number>();
  const defensesByFranchise = new Map<number, number>();
  let longest: BeltRecordsIds["longestReign"] = null;

  for (const r of reigns) {
    countByFranchise.set(r.franchiseId, (countByFranchise.get(r.franchiseId) ?? 0) + 1);
    defensesByFranchise.set(r.franchiseId, (defensesByFranchise.get(r.franchiseId) ?? 0) + r.defenses);
    if (!longest || r.weeksHeld > longest.weeksHeld) {
      longest = { franchiseId: r.franchiseId, weeksHeld: r.weeksHeld, startSeason: r.startSeason, startWeek: r.startWeek };
    }
  }

  let mostReigns: BeltRecordsIds["mostReigns"] = null;
  for (const [franchiseId, count] of countByFranchise) {
    if (!mostReigns || count > mostReigns.count) mostReigns = { franchiseId, count };
  }

  let mostDefenses: BeltRecordsIds["mostDefenses"] = null;
  for (const [franchiseId, defenses] of defensesByFranchise) {
    if (!mostDefenses || defenses > mostDefenses.defenses) mostDefenses = { franchiseId, defenses };
  }

  return { mostReigns, longestReign: longest, mostDefenses };
}

export interface BeltRecords {
  mostReigns: { franchiseId: number; name: string; count: number } | null;
  longestReign: { franchiseId: number; name: string; weeksHeld: number; startSeason: number; startWeek: number } | null;
  mostDefenses: { franchiseId: number; name: string; defenses: number } | null;
}

export function getBeltRecords(): BeltRecords {
  const db = getDb();
  const reigns = db
    .select({
      franchiseId: beltReigns.franchiseId,
      weeksHeld: beltReigns.weeksHeld,
      defenses: beltReigns.defenses,
      startSeason: beltReigns.startSeason,
      startWeek: beltReigns.startWeek,
    })
    .from(beltReigns)
    .all();
  const ids = computeBeltRecords(reigns);

  const franchiseRows = db.select({ id: franchises.id, name: franchises.canonicalName }).from(franchises).all();
  const nameById = new Map(franchiseRows.map((f) => [f.id, f.name]));
  const nameOf = (id: number) => nameById.get(id) ?? `Franchise ${id}`;

  return {
    mostReigns: ids.mostReigns ? { ...ids.mostReigns, name: nameOf(ids.mostReigns.franchiseId) } : null,
    longestReign: ids.longestReign ? { ...ids.longestReign, name: nameOf(ids.longestReign.franchiseId) } : null,
    mostDefenses: ids.mostDefenses ? { ...ids.mostDefenses, name: nameOf(ids.mostDefenses.franchiseId) } : null,
  };
}

export interface CurrentReignDetail {
  franchiseId: number;
  franchiseName: string;
  reignNo: number;
  defenses: number;
  weeksHeld: number;
  startSeason: number;
  startWeek: number;
  wonFromName: string | null;
  wonFromScore: number | null;
  holderWinScore: number | null;
}

/** The current-reign hero card's data: holder, span, and (if there was one) the title-winning match's score. */
export function getCurrentReignDetail(): CurrentReignDetail | null {
  const db = getDb();
  const reign = db.select().from(beltReigns).where(eq(beltReigns.isCurrent, true)).get();
  if (!reign) return null;

  const franchise = db.select({ name: franchises.canonicalName }).from(franchises).where(eq(franchises.id, reign.franchiseId)).get();

  let wonFromName: string | null = null;
  let wonFromScore: number | null = null;
  let holderWinScore: number | null = null;

  if (reign.wonFromFranchiseId !== null) {
    const wonFromFranchise = db
      .select({ name: franchises.canonicalName })
      .from(franchises)
      .where(eq(franchises.id, reign.wonFromFranchiseId))
      .get();
    wonFromName = wonFromFranchise?.name ?? null;

    const match = db
      .select()
      .from(beltMatches)
      .where(
        and(
          eq(beltMatches.season, reign.startSeason),
          eq(beltMatches.week, reign.startWeek),
          eq(beltMatches.holderFranchiseId, reign.wonFromFranchiseId),
          eq(beltMatches.challengerFranchiseId, reign.franchiseId),
          eq(beltMatches.result, "transfer"),
        ),
      )
      .get();
    if (match) {
      wonFromScore = match.holderScore;
      holderWinScore = match.challengerScore;
    }
  }

  return {
    franchiseId: reign.franchiseId,
    franchiseName: franchise?.name ?? "—",
    reignNo: reign.reignNo,
    defenses: reign.defenses,
    weeksHeld: reign.weeksHeld,
    startSeason: reign.startSeason,
    startWeek: reign.startWeek,
    wonFromName,
    wonFromScore,
    holderWinScore,
  };
}

// ---------------------------------------------------------------------------
// Matchup detail score head — "Belt holder · reign N" (README, Matchup detail)
// ---------------------------------------------------------------------------

export interface ReignSpan {
  reignNo: number;
  franchiseId: number;
  startSeason: number;
  startWeek: number;
  endSeason: number | null;
  endWeek: number | null;
}

/**
 * Which reign (by `reignNo`) `franchiseId` was holding at a given (season, week) — the matchup
 * detail score head's gold eyebrow needs this for ANY belt game, not just the current one (e.g.
 * a 2019 defense should still read "reign 6", not the current reign's number). Compares (season,
 * week) as a single sortable int (season*100+week — a week number never reaches 100) against each
 * reign's [start, end] span; an open end (`endSeason`/`endWeek` null, still current) matches
 * anything from its start onward. Pure.
 */
export function findReignNoForGame(reigns: ReignSpan[], franchiseId: number, season: number, week: number): number | null {
  const point = season * 100 + week;
  for (const r of reigns) {
    if (r.franchiseId !== franchiseId) continue;
    const start = r.startSeason * 100 + r.startWeek;
    const end = r.endSeason !== null && r.endWeek !== null ? r.endSeason * 100 + r.endWeek : Infinity;
    if (point >= start && point <= end) return r.reignNo;
  }
  return null;
}

/** DB-facing wrapper over `findReignNoForGame`, reusing `getBeltLineage`'s own franchise-resolved
 * rows rather than a second query. */
export function getReignNoForGame(franchiseId: number, season: number, week: number): number | null {
  const lineage = getBeltLineage();
  const spans: ReignSpan[] = lineage.map((r) => ({
    reignNo: r.reignNo,
    franchiseId: r.holderId,
    startSeason: r.startSeason,
    startWeek: r.startWeek,
    endSeason: r.endSeason,
    endWeek: r.endWeek,
  }));
  return findReignNoForGame(spans, franchiseId, season, week);
}
