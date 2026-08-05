/**
 * Timeline v1 — derived server-side from existing derived tables (no events
 * infra yet, per the brief). Kept as one module with a stable
 * `getTimelineEntries()` / `filterTimelineEntries()` interface so a future
 * events-table-backed version can swap in behind the same shape without
 * touching callers.
 */
import { eq } from "drizzle-orm";
import { RECORD_KEY_META } from "@/server/queries/records";
import { getDb } from "@/server/db/client";
import { beltReigns, franchises, recordEntries, seasonStats } from "@/server/db/schema";
import type { RecordKey } from "@/engines";

export const TIMELINE_EVENT_TYPES = ["championship", "sacko", "belt_transfer", "belt_vacancy", "record", "arrival", "departure"] as const;
export type TimelineEventType = (typeof TIMELINE_EVENT_TYPES)[number];

export const TIMELINE_TYPE_LABELS: Record<TimelineEventType, string> = {
  championship: "Championships",
  sacko: "Sackos",
  belt_transfer: "Belt Transfers",
  belt_vacancy: "Belt Vacancies",
  record: "Records",
  arrival: "Arrivals",
  departure: "Departures",
};

export interface TimelineEntry {
  type: TimelineEventType;
  season: number;
  week: number | null;
  franchiseId: number | null;
  franchiseName: string;
  eyebrow: string;
  statement: string;
  href: string;
  gold: boolean;
}

interface SortableEntry extends TimelineEntry {
  sortKey: number;
}

/**
 * A within-season ordinal so mixed-granularity events (a season-level
 * championship vs. a specific-week belt transfer) still sort sensibly:
 * arrivals first (start of season), then week-specific events in week
 * order, then season-scope records (no real week), then
 * championship/sacko (the season's culmination), then departures (after the
 * season concludes). Pure.
 */
export function computeTimelineSortKey(type: TimelineEventType, season: number, week: number | null): number {
  let weekish: number;
  if (type === "arrival") weekish = 0;
  else if (week !== null) weekish = 10 + week;
  else if (type === "record") weekish = 5;
  else if (type === "championship" || type === "sacko") weekish = 900;
  else weekish = 950; // departure
  return season * 1000 + weekish;
}

/** Newest first; stable secondary order by type name for determinism on ties. Pure. */
export function sortTimelineEntries(entries: TimelineEntry[]): TimelineEntry[] {
  const withKeys: SortableEntry[] = entries.map((e) => ({ ...e, sortKey: computeTimelineSortKey(e.type, e.season, e.week) }));
  withKeys.sort((a, b) => b.sortKey - a.sortKey || a.type.localeCompare(b.type));
  return withKeys.map((e): TimelineEntry => {
    const { type, season, week, franchiseId, franchiseName, eyebrow, statement, href, gold } = e;
    return { type, season, week, franchiseId, franchiseName, eyebrow, statement, href, gold };
  });
}

export interface TimelineFilters {
  season?: number;
  franchiseId?: number;
  type?: TimelineEventType;
}

/** Pure — unit-tested directly. */
export function filterTimelineEntries(entries: TimelineEntry[], filters: TimelineFilters): TimelineEntry[] {
  return entries.filter((e) => {
    if (filters.season !== undefined && e.season !== filters.season) return false;
    if (filters.franchiseId !== undefined && e.franchiseId !== filters.franchiseId) return false;
    if (filters.type !== undefined && e.type !== filters.type) return false;
    return true;
  });
}

export function getAvailableSeasons(entries: TimelineEntry[]): number[] {
  return [...new Set(entries.map((e) => e.season))].sort((a, b) => b - a);
}

export function getAvailableFranchises(entries: TimelineEntry[]): { id: number; name: string }[] {
  const byId = new Map<number, string>();
  for (const e of entries) {
    if (e.franchiseId !== null && !byId.has(e.franchiseId)) byId.set(e.franchiseId, e.franchiseName);
  }
  return [...byId.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** The full, unfiltered timeline, newest first. Page applies filterTimelineEntries() on top. */
export function getTimelineEntries(): TimelineEntry[] {
  const db = getDb();
  const franchiseRows = db.select().from(franchises).all();
  const nameById = new Map(franchiseRows.map((f) => [f.id, f.canonicalName]));
  const nameOf = (id: number) => nameById.get(id) ?? `Franchise ${id}`;

  const entries: TimelineEntry[] = [];

  const championRows = db
    .select({ season: seasonStats.season, franchiseId: seasonStats.franchiseId })
    .from(seasonStats)
    .where(eq(seasonStats.champion, true))
    .all();
  for (const c of championRows) {
    entries.push({
      type: "championship",
      season: c.season,
      week: null,
      franchiseId: c.franchiseId,
      franchiseName: nameOf(c.franchiseId),
      eyebrow: `${c.season} Champion`,
      statement: `${nameOf(c.franchiseId)} won the ${c.season} championship.`,
      href: `/seasons/${c.season}`,
      gold: true,
    });
  }

  const sackoRows = db
    .select({ season: seasonStats.season, franchiseId: seasonStats.franchiseId })
    .from(seasonStats)
    .where(eq(seasonStats.sacko, true))
    .all();
  for (const s of sackoRows) {
    entries.push({
      type: "sacko",
      season: s.season,
      week: null,
      franchiseId: s.franchiseId,
      franchiseName: nameOf(s.franchiseId),
      eyebrow: `${s.season} Sacko`,
      statement: `${nameOf(s.franchiseId)} finished as the ${s.season} sacko.`,
      href: `/seasons/${s.season}`,
      gold: false,
    });
  }

  const reignRows = db.select().from(beltReigns).all();
  for (const r of reignRows) {
    const isVacancy = r.wonFromFranchiseId === null;
    entries.push({
      type: isVacancy ? "belt_vacancy" : "belt_transfer",
      season: r.startSeason,
      week: r.startWeek,
      franchiseId: r.franchiseId,
      franchiseName: nameOf(r.franchiseId),
      eyebrow: isVacancy ? "Belt Awarded" : "Belt Changes Hands",
      statement: isVacancy
        ? `${nameOf(r.franchiseId)} was awarded the belt into a vacant title.`
        : `${nameOf(r.franchiseId)} took the belt from ${nameOf(r.wonFromFranchiseId!)}.`,
      href: "/belt",
      gold: true,
    });
  }

  const rank1Rows = db.select().from(recordEntries).where(eq(recordEntries.rank, 1)).all();
  for (const rec of rank1Rows) {
    const key = rec.recordKey as RecordKey;
    const meta = RECORD_KEY_META[key];
    entries.push({
      type: "record",
      season: rec.season,
      week: rec.week,
      franchiseId: rec.franchiseId,
      franchiseName: nameOf(rec.franchiseId),
      eyebrow: "Record",
      statement: `${nameOf(rec.franchiseId)} set the record for ${meta.label}: ${meta.format(rec.value)}.`,
      href: "/records",
      gold: meta.group === "belt" || meta.group === "championship",
    });
  }

  for (const f of franchiseRows) {
    entries.push({
      type: "arrival",
      season: f.joinedSeason,
      week: null,
      franchiseId: f.id,
      franchiseName: f.canonicalName,
      eyebrow: "New Franchise",
      statement: `${f.canonicalName} joined the league.`,
      href: `/franchises/${f.id}`,
      gold: false,
    });
    if (f.departedSeason !== null) {
      entries.push({
        type: "departure",
        season: f.departedSeason,
        week: null,
        franchiseId: f.id,
        franchiseName: f.canonicalName,
        eyebrow: "Departure",
        statement: `${f.canonicalName} left the league.`,
        href: `/franchises/${f.id}`,
        gold: false,
      });
    }
  }

  return sortTimelineEntries(entries);
}
