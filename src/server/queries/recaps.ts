import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { recaps, type Recap } from "../db/schema";

/**
 * Public (any logged-in manager, not just the commissioner) recap reads — /recaps and
 * /recaps/[year]/[week] never see a draft or an unpublished row. Multiple `recaps` rows can exist
 * for the same (season, week) over time (regenerate, switch-to-fallback, re-publish); "the"
 * published recap for a week is always the MOST RECENTLY published row, never an arbitrary one —
 * see publishRecapAction's docstring in src/features/recaps/actions.ts.
 */

export interface PublishedRecapSummary {
  id: number;
  season: number;
  week: number;
  style: string;
  createdAt: Date;
}

/** Every season that has at least one published recap, newest first. */
export function getPublishedRecapSeasons(): number[] {
  const db = getDb();
  const rows = db.select({ season: recaps.season }).from(recaps).where(eq(recaps.status, "published")).all();
  return [...new Set(rows.map((r) => r.season))].sort((a, b) => b - a);
}

/** Published recaps for one season, one row per (week) — the most recently published row wins
 * when a week has been re-published more than once. Newest week first. */
export function getPublishedRecapsForSeason(season: number): PublishedRecapSummary[] {
  const db = getDb();
  const rows = db
    .select({ id: recaps.id, season: recaps.season, week: recaps.week, style: recaps.style, createdAt: recaps.createdAt })
    .from(recaps)
    .where(and(eq(recaps.season, season), eq(recaps.status, "published")))
    .orderBy(desc(recaps.createdAt), desc(recaps.id))
    .all();

  const byWeek = new Map<number, PublishedRecapSummary>();
  for (const r of rows) {
    if (!byWeek.has(r.week)) byWeek.set(r.week, r);
  }
  return [...byWeek.values()].sort((a, b) => b.week - a.week);
}

/** The published recap for one (season, week), or null when nothing's published for it yet
 * (the page 404s in that case — see /recaps/[year]/[week]/page.tsx). */
export function getPublishedRecap(season: number, week: number): Recap | null {
  const db = getDb();
  const row = db
    .select()
    .from(recaps)
    .where(and(eq(recaps.season, season), eq(recaps.week, week), eq(recaps.status, "published")))
    .orderBy(desc(recaps.createdAt), desc(recaps.id))
    .limit(1)
    .get();
  return row ?? null;
}

/** The single most recently published recap across the whole league — the home page's recap
 * card. Null when nothing has ever been published. */
export function getLatestPublishedRecap(): PublishedRecapSummary | null {
  const db = getDb();
  const row = db
    .select({ id: recaps.id, season: recaps.season, week: recaps.week, style: recaps.style, createdAt: recaps.createdAt })
    .from(recaps)
    .where(eq(recaps.status, "published"))
    .orderBy(desc(recaps.createdAt), desc(recaps.id))
    .limit(1)
    .get();
  return row ?? null;
}
