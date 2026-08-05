"use server";

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { requireCommissioner } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import { recaps } from "@/server/db/schema";
import { RecapIncompleteWeekError, type WeekFacts } from "@/server/ai/facts";
import { generateRecap, RecapApiKeyMissingError, renderFallbackRecap } from "@/server/ai/recap";
import { getRecapStyle } from "@/server/ai/styles";
import { captureExemplarOnPublish } from "@/server/ai/voice";

/**
 * /admin/recaps is a commissioner-only mutation surface, same rule as /admin (src/features/admin/
 * actions.ts's docstring): every action here calls requireCommissioner() itself, first thing —
 * the (league) layout's requireManager() check does not re-run on client-side soft navigation, so
 * it can't be the authoritative gate for a mutation.
 */

function redirectWithError(basePath: string, error: string): never {
  redirect(`${basePath}?error=${encodeURIComponent(error)}`);
}

/** Used by both the list page's "Generate" form and the detail page's "Regenerate" button (same
 * season/week/style, a fresh draft row each time) — deliberately one action, not two. */
export async function generateRecapAction(formData: FormData): Promise<void> {
  await requireCommissioner();

  // Accepts EITHER a combined "seasonWeek" field ("2025-14", the list page's single-<select>
  // picker — no client JS required for a dependent dropdown) OR separate season/week fields (the
  // detail page's "Regenerate" button, which already knows both as plain hidden inputs).
  const seasonWeekRaw = formData.get("seasonWeek");
  let season: number;
  let week: number;
  if (typeof seasonWeekRaw === "string" && seasonWeekRaw.length > 0) {
    const match = /^(\d+)-(\d+)$/.exec(seasonWeekRaw);
    season = match ? Number(match[1]) : NaN;
    week = match ? Number(match[2]) : NaN;
  } else {
    season = Number(formData.get("season"));
    week = Number(formData.get("week"));
  }
  const styleId = String(formData.get("styleId") ?? "");
  if (!Number.isInteger(season) || !Number.isInteger(week)) redirectWithError("/admin/recaps", "Pick a valid season and week.");
  if (!getRecapStyle(styleId)) redirectWithError("/admin/recaps", "Pick a valid style.");

  const db = getDb();
  let newId: number;
  try {
    const row = await generateRecap({ db, season, week, styleId });
    newId = row.id;
  } catch (err) {
    if (err instanceof RecapApiKeyMissingError) {
      redirectWithError("/admin/recaps", "No Claude API key is configured — use an existing draft's “Switch to Fallback” action, or set ANTHROPIC_API_KEY.");
    }
    if (err instanceof RecapIncompleteWeekError) {
      redirectWithError("/admin/recaps", `Week ${week} of season ${season} is not complete yet.`);
    }
    throw err;
  }
  redirect(`/admin/recaps/${newId}`);
}

/** Inserts a NEW draft row rendered by the deterministic fallback template, reusing the SOURCE
 * row's already-committed facts (never rebuilds facts from the live DB — "switch to fallback" is
 * a pure transformation of what this row already captured, not a fresh generation). */
export async function switchToFallbackAction(formData: FormData): Promise<void> {
  await requireCommissioner();

  const sourceId = Number(formData.get("recapId"));
  if (!Number.isInteger(sourceId)) redirectWithError("/admin/recaps", "Invalid recap.");

  const db = getDb();
  const source = db.select().from(recaps).where(eq(recaps.id, sourceId)).get();
  if (!source) redirectWithError("/admin/recaps", "Recap not found.");

  const facts = source.factsJson as WeekFacts;
  const markdown = renderFallbackRecap(facts);

  const inserted = db
    .insert(recaps)
    .values({
      season: source.season,
      week: source.week,
      style: source.style,
      status: "draft",
      factsJson: facts,
      promptVersion: null,
      model: null,
      markdownDraft: markdown,
      // Same frozen-at-creation convention as generateRecap — this new row's OWN "as generated"
      // text is the fallback template's output, so a later hand-edit of it is still capturable.
      markdownGenerated: markdown,
      markdownFinal: null,
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
    })
    .returning()
    .get();

  redirect(`/admin/recaps/${inserted.id}`);
}

/** Sets status to 'edited' — `markdownFinal` is untouched until publish, so an edited draft can
 * still be reviewed/re-edited any number of times before it ever becomes the public version. */
export async function saveRecapEditAction(formData: FormData): Promise<void> {
  await requireCommissioner();

  const recapId = Number(formData.get("recapId"));
  const markdown = String(formData.get("markdown") ?? "");
  if (!Number.isInteger(recapId)) redirectWithError("/admin/recaps", "Invalid recap.");
  if (markdown.trim().length === 0) redirectWithError(`/admin/recaps/${recapId}`, "Markdown can't be empty.");

  const db = getDb();
  const existing = db.select({ id: recaps.id }).from(recaps).where(eq(recaps.id, recapId)).get();
  if (!existing) redirectWithError("/admin/recaps", "Recap not found.");

  db.update(recaps).set({ markdownDraft: markdown, status: "edited" }).where(eq(recaps.id, recapId)).run();
  redirect(`/admin/recaps/${recapId}?success=saved`);
}

/** Freezes the current markdownDraft into markdownFinal and marks the row 'published' — this is
 * the ONLY thing the public /recaps pages will ever read. Publishing a NEWER recap for the same
 * (season, week) simply supersedes the older published row for that week (the public query always
 * takes the most recently published row — see src/server/queries/recaps.ts); it does not delete
 * or unpublish the older one, preserving history. */
export async function publishRecapAction(formData: FormData): Promise<void> {
  await requireCommissioner();

  const recapId = Number(formData.get("recapId"));
  if (!Number.isInteger(recapId)) redirectWithError("/admin/recaps", "Invalid recap.");

  const db = getDb();
  const existing = db.select().from(recaps).where(eq(recaps.id, recapId)).get();
  if (!existing) redirectWithError("/admin/recaps", "Recap not found.");
  if (!existing.markdownDraft) redirectWithError(`/admin/recaps/${recapId}`, "Nothing to publish yet.");

  db.update(recaps).set({ markdownFinal: existing.markdownDraft, status: "published" }).where(eq(recaps.id, recapId)).run();
  // Task 16: captures a revision exemplar iff this recap's frozen "as generated" text differs
  // from what's actually being published — no-op for an unchanged publish or a pre-Task-16 row
  // with nothing captured. See captureExemplarOnPublish's docstring.
  captureExemplarOnPublish(db, existing, existing.markdownDraft);
  redirect(`/admin/recaps/${recapId}?success=published`);
}
