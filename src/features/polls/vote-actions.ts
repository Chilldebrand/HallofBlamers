"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { requireManager } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import { pollOptions, pollVotes, polls } from "@/server/db/schema";
import { findMatchingOption } from "@/server/queries/polls";

/**
 * The first MEMBER-level (not commissioner-only) mutation surface in this codebase —
 * requireManager() (not requireCommissioner()) inside, first thing, same self-gating rule as
 * every admin action (see src/features/polls/actions.ts's docstring): the (league) layout's
 * requireManager() check runs once per full render and does not re-run on soft navigation, so it
 * can't be relied on as the authoritative gate for a mutation either. requireManager() accepts
 * BOTH roles ("manager" and "commissioner") — a commissioner is stored in the same `managers`
 * table and can vote in their own polls exactly like anyone else.
 */

class PollVoteValidationError extends Error {}

function redirectWithError(pollId: number, error: string): never {
  redirect(`/polls/${pollId}?error=${encodeURIComponent(error)}`);
}

/**
 * Casts (or replaces) one manager's vote in one poll. Single-choice: delete every prior vote for
 * this (poll, manager) then insert exactly one — a genuine "revote replaces the old answer,"
 * never an accumulation. Multi-choice: the submitted checkbox set IS the manager's new full
 * selection — rows for options they unchecked are deleted, rows for options they newly checked
 * are inserted, rows for options that were already checked and stay checked are left untouched
 * (a per-option toggle at the DATA level, computed as one diff rather than N separate clicks,
 * since this app has no client JS and every form here submits as one whole unit). Write-in
 * creation (find-or-create, case-insensitive dedupe against ALL existing options) happens INSIDE
 * the same transaction as the vote write, so an invalid submission (e.g. two choices on a
 * single-choice poll) rolls back the write-in insert too — never an orphan option with no vote.
 */
export async function submitVoteAction(formData: FormData): Promise<void> {
  const manager = await requireManager();

  const pollId = Number(formData.get("pollId"));
  if (!Number.isInteger(pollId)) redirect("/polls?error=Invalid%20poll.");

  const db = getDb();
  const poll = db.select().from(polls).where(eq(polls.id, pollId)).get();
  if (!poll) redirect("/polls?error=Poll%20not%20found.");
  if (poll.status !== "open") redirectWithError(pollId, "This poll isn't open for voting.");

  const rawOptionSelections = formData
    .getAll("optionId")
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n));
  const writeInLabelRaw = String(formData.get("writeInLabel") ?? "").trim();

  try {
    db.transaction((tx) => {
      let writeInOptionId: number | null = null;
      if (poll.allowWriteIn && writeInLabelRaw.length > 0) {
        const existingOptions = tx.select().from(pollOptions).where(eq(pollOptions.pollId, pollId)).all();
        const match = findMatchingOption(existingOptions, writeInLabelRaw);
        if (match) {
          writeInOptionId = match.id;
        } else {
          const maxSort = existingOptions.reduce((m, o) => Math.max(m, o.sort), -1);
          const inserted = tx.insert(pollOptions).values({ pollId, label: writeInLabelRaw, sort: maxSort + 1, isWriteIn: true }).returning().get();
          writeInOptionId = inserted.id;
        }
      }

      const finalSelection = [...new Set(writeInOptionId !== null ? [...rawOptionSelections, writeInOptionId] : rawOptionSelections)];

      if (finalSelection.length === 0) throw new PollVoteValidationError("Pick at least one option.");
      if (poll.kind === "single" && finalSelection.length > 1) throw new PollVoteValidationError("This poll only accepts one choice.");

      if (poll.kind === "single") {
        tx.delete(pollVotes).where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.managerId, manager.id))).run();
        tx.insert(pollVotes).values({ pollId, optionId: finalSelection[0]!, managerId: manager.id }).run();
        return;
      }

      const existingVotedOptionIds = tx
        .select({ optionId: pollVotes.optionId })
        .from(pollVotes)
        .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.managerId, manager.id)))
        .all()
        .map((r) => r.optionId);
      const existingSet = new Set(existingVotedOptionIds);
      const selectedSet = new Set(finalSelection);

      for (const optionId of existingVotedOptionIds) {
        if (!selectedSet.has(optionId)) {
          tx.delete(pollVotes)
            .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.optionId, optionId), eq(pollVotes.managerId, manager.id)))
            .run();
        }
      }
      for (const optionId of finalSelection) {
        if (!existingSet.has(optionId)) {
          tx.insert(pollVotes).values({ pollId, optionId, managerId: manager.id }).run();
        }
      }
    });
  } catch (err) {
    if (err instanceof PollVoteValidationError) redirectWithError(pollId, err.message);
    throw err;
  }

  redirect(`/polls/${pollId}?success=voted`);
}
