"use server";

import { redirect } from "next/navigation";
import { requireCommissioner, requireManager } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import { appSettings, pickemPicks } from "@/server/db/schema";
import { getCurrentPickemWeek, getPickemMatchupRows } from "@/server/queries/pickem";
import { isPickemLocked, PICKEM_AI_ENABLED_KEY } from "@/server/sync/pickem-lock";
import { validatePickSubmission } from "./validation";

function redirectWithError(error: string): never {
  redirect(`/pickem?error=${encodeURIComponent(error)}`);
}

/**
 * Submits/edits the signed-in manager's picks for the CURRENT pick'em week — per-manager write
 * isolation: always writes under `manager.id` from requireManager()'s session, NEVER a
 * client-submitted id (same rule as src/features/polls/vote-actions.ts's submitVoteAction).
 * "Editable until lock": recomputes the current week + lock state itself, server-side, rather than
 * trusting the submitted season/week hidden fields — a stale form (opened before lock, submitted
 * after) is rejected here, not merely hidden client-side. Upserts one row per matchup: a manager
 * resubmitting before lock replaces their prior picks in place (same matchupId+managerId), never
 * accumulates duplicate rows.
 */
export async function submitPicksAction(formData: FormData): Promise<void> {
  const manager = await requireManager();

  const db = getDb();
  const current = getCurrentPickemWeek(db);
  if (!current) redirectWithError("There's nothing to pick right now.");

  const submittedSeason = Number(formData.get("season"));
  const submittedWeek = Number(formData.get("week"));
  if (submittedSeason !== current.season || submittedWeek !== current.week) {
    redirectWithError("This week's picks have moved on — reload the page and try again.");
  }

  if (isPickemLocked(db, current.season, current.week, new Date())) {
    redirectWithError("Picks for this week are locked.");
  }

  const pickableMatchups = getPickemMatchupRows(db, current.season, current.week);
  const submitted = new Map<number, number | undefined>();
  for (const m of pickableMatchups) {
    const raw = formData.get(`pick_${m.matchupId}`);
    submitted.set(m.matchupId, typeof raw === "string" && raw.length > 0 ? Number(raw) : undefined);
  }

  const validated = validatePickSubmission(submitted, pickableMatchups);
  if (!validated.ok) redirectWithError(validated.error);

  const now = new Date();
  db.transaction((tx) => {
    for (const pick of validated.value) {
      tx.insert(pickemPicks)
        .values({
          managerId: manager.id,
          isAlgorithm: false,
          season: current.season,
          week: current.week,
          matchupId: pick.matchupId,
          pickedFranchiseId: pick.pickedFranchiseId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [pickemPicks.managerId, pickemPicks.matchupId],
          set: { pickedFranchiseId: pick.pickedFranchiseId, updatedAt: now },
        })
        .run();
    }
  });

  redirect("/pickem?success=picks_saved");
}

/**
 * Commissioner-only "AI Picks" toggle — lives on /pickem itself (brief: "the pickem page's
 * admin-only toggle"), NOT under /admin. requireCommissioner() itself, first thing — same
 * self-gating rule as every commissioner mutation in this codebase (src/features/admin/actions.ts's
 * docstring): the (league) layout's requireManager() check doesn't re-run on client-side soft
 * navigation, so it can't be the authoritative gate for a mutation.
 */
export async function setAiEnabledAction(formData: FormData): Promise<void> {
  await requireCommissioner();

  const enabled = formData.get("aiEnabled") === "on";
  const db = getDb();
  const now = new Date();
  db.insert(appSettings)
    .values({ key: PICKEM_AI_ENABLED_KEY, valueJson: enabled, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { valueJson: enabled, updatedAt: now } })
    .run();

  redirect("/pickem?success=ai_toggle");
}
