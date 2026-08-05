import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { recaps, weeks, type Recap, type RecapStyleGuide } from "@/server/db/schema";
import { getActiveStyleGuide, getExemplarCount, getManualVoiceNotes } from "@/server/ai/voice";

/** True when the ADMIN UI can offer real Claude generation — the list/detail pages use this to
 * show fallback-only mode clearly (brief's explicit requirement) rather than letting a commissioner
 * discover the missing key only after submitting the Generate form. */
export function hasAnthropicApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export interface RecapAdminFilter {
  season?: number;
  week?: number;
  status?: Recap["status"];
}

/** Every recap row, most recent first, optionally filtered — the /admin/recaps list table. */
export function getRecapAdminList(filter: RecapAdminFilter = {}): Recap[] {
  const db = getDb();
  const conditions = [];
  if (filter.season !== undefined) conditions.push(eq(recaps.season, filter.season));
  if (filter.week !== undefined) conditions.push(eq(recaps.week, filter.week));
  if (filter.status !== undefined) conditions.push(eq(recaps.status, filter.status));

  const query = db.select().from(recaps).orderBy(desc(recaps.id));
  return (conditions.length > 0 ? query.where(and(...conditions)) : query).all();
}

export function getRecapById(id: number): Recap | null {
  const db = getDb();
  return db.select().from(recaps).where(eq(recaps.id, id)).get() ?? null;
}

export interface CompletedWeekOption {
  season: number;
  week: number;
}

/** Every completed week, newest first — the Generate form's week picker. A week only ever needs
 * to appear once here regardless of how many recap rows already exist for it (re-generating and
 * retro recaps are both explicitly supported — see the brief's "retro capability" deliverable). */
export function getCompletedWeekOptions(): CompletedWeekOption[] {
  const db = getDb();
  return db
    .select({ season: weeks.season, week: weeks.week })
    .from(weeks)
    .where(eq(weeks.isComplete, true))
    .all()
    .sort((a, b) => (b.season - a.season) || (b.week - a.week));
}

export interface VoiceAdminState {
  manualNotes: string;
  activeGuide: RecapStyleGuide | null;
  /** Total captured revision exemplars available right now — NOT necessarily the same as
   * `activeGuide.exemplarCount` (that's a snapshot of how many fed the CURRENT guide text; more
   * may have been captured since the last extraction, which is exactly when re-running "Update
   * writing style from my edits" is worth doing again). */
  exemplarCount: number;
}

/** Everything the /admin/recaps/voice page needs in one call. */
export function getVoiceAdminState(): VoiceAdminState {
  const db = getDb();
  return {
    manualNotes: getManualVoiceNotes(db),
    activeGuide: getActiveStyleGuide(db),
    exemplarCount: getExemplarCount(db),
  };
}
