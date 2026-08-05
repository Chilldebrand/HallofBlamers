"use server";

import { redirect } from "next/navigation";
import { requireManager } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import { predictions } from "@/server/db/schema";
import { getActiveFranchises, getPredictionsSeason, getWinTotalMax, isPredictionsLocked } from "@/server/queries/predictions";
import { toPredictionRows, validatePredictionsForm, type PredictionsFormInput } from "./validation";

/**
 * /predictions is a member-writes-OWN-data surface — same self-gating rule as every mutation in
 * this codebase (see src/features/polls/vote-actions.ts's docstring): the (league) layout's
 * requireManager() check runs once per full render and does not re-run on client-side soft
 * navigation, so it can't be the authoritative gate here either. requireManager() (not
 * requireCommissioner()) — any signed-in manager, including a commissioner, predicts for
 * themselves like everyone else.
 *
 * The whole "a manager can only ever write their OWN set" enforcement is structural, not a
 * checked condition: `manager.id` comes from the verified session and is the ONLY managerId ever
 * used below — there is no managerId field on the form at all, so there is nothing for a
 * malicious/buggy client to submit that would target someone else's rows.
 */

function redirectWithError(error: string): never {
  redirect(`/predictions?error=${encodeURIComponent(error)}`);
}

function readFormInput(formData: FormData): PredictionsFormInput {
  return {
    champion: String(formData.get("champion") ?? ""),
    sacko: String(formData.get("sacko") ?? ""),
    topScorer: String(formData.get("topScorer") ?? ""),
    winTotal: String(formData.get("winTotal") ?? ""),
    boldTake: String(formData.get("boldTake") ?? ""),
  };
}

export async function savePredictionsAction(formData: FormData): Promise<void> {
  const manager = await requireManager();
  const db = getDb();

  const season = getPredictionsSeason(db);
  if (season === null) redirectWithError("There's no season to predict on yet.");

  // The authoritative lock gate — the SAME isSeasonUnderway signal the live sync tier uses (first
  // real game played, NOT the draft date), checked here regardless of what the page happened to
  // render for this request. See src/server/queries/predictions.ts's isPredictionsLocked.
  if (isPredictionsLocked(db, season)) {
    redirectWithError("Too late — the season's underway. Predictions are locked.");
  }

  const activeFranchiseIds = new Set(getActiveFranchises(db).map((f) => f.id));
  const winTotalMax = getWinTotalMax(db, season) ?? 14;
  const hasFranchise = manager.franchiseId !== null;

  const parsed = validatePredictionsForm(readFormInput(formData), { activeFranchiseIds, hasFranchise, winTotalMax });
  if (!parsed.ok) redirectWithError(parsed.error);

  const rows = toPredictionRows(parsed.value);
  const now = new Date();

  // One transaction, upsert-per-row (UNIQUE(manager_id, season, category) backs the conflict
  // target) — an edit updates `subject`/`updated_at` in place rather than deleting and
  // re-inserting, so `created_at` reflects when the manager FIRST predicted this category, not
  // their latest edit.
  db.transaction((tx) => {
    for (const row of rows) {
      tx.insert(predictions)
        .values({ managerId: manager.id, season, category: row.category, subject: row.subject, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: [predictions.managerId, predictions.season, predictions.category],
          set: { subject: row.subject, updatedAt: now },
        })
        .run();
    }
  });

  redirect("/predictions?success=saved");
}
