"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { requireCommissioner } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import { pollOptions, pollVotes, polls } from "@/server/db/schema";
import { validatePollForm, type PollFormInput } from "./validation";

/**
 * /admin/polls is a commissioner-only mutation surface, same rule as /admin and /admin/recaps
 * (see src/features/admin/actions.ts's docstring, src/features/recaps/actions.ts's docstring):
 * every action here calls requireCommissioner() itself, first thing — the (league) layout's
 * requireManager() check does not re-run on client-side soft navigation, so it can't be the
 * authoritative gate for a mutation. Member VOTING actions live in a separate file
 * (./vote-actions.ts, requireManager) — kept apart from this file so the security boundary
 * between "administers polls" and "votes in polls" is visible at a glance, not just enforced
 * inline.
 */

function redirectWithError(basePath: string, error: string): never {
  redirect(`${basePath}?error=${encodeURIComponent(error)}`);
}

function readPollFormInput(formData: FormData): PollFormInput {
  return {
    question: String(formData.get("question") ?? ""),
    description: String(formData.get("description") ?? ""),
    kind: String(formData.get("kind") ?? ""),
    anonymous: formData.get("anonymous") === "on",
    allowWriteIn: formData.get("allowWriteIn") === "on",
    closesAt: String(formData.get("closesAt") ?? ""),
    options: formData.getAll("option").map((v) => String(v)),
  };
}

export async function createPollAction(formData: FormData): Promise<void> {
  const manager = await requireCommissioner();

  const parsed = validatePollForm(readPollFormInput(formData));
  if (!parsed.ok) redirectWithError("/admin/polls", parsed.error);

  const db = getDb();
  const inserted = db
    .transaction((tx) => {
      const poll = tx
        .insert(polls)
        .values({
          question: parsed.value.question,
          description: parsed.value.description,
          kind: parsed.value.kind,
          status: "draft",
          anonymous: parsed.value.anonymous,
          allowWriteIn: parsed.value.allowWriteIn,
          createdBy: manager.id,
          closesAt: parsed.value.closesAt,
        })
        .returning()
        .get();
      parsed.value.options.forEach((label, i) => {
        tx.insert(pollOptions).values({ pollId: poll.id, label, sort: i, isWriteIn: false }).run();
      });
      return poll;
    });

  redirect(`/admin/polls/${inserted.id}?success=created`);
}

export async function updatePollAction(formData: FormData): Promise<void> {
  await requireCommissioner();

  const pollId = Number(formData.get("pollId"));
  if (!Number.isInteger(pollId)) redirectWithError("/admin/polls", "Invalid poll.");

  const db = getDb();
  const poll = db.select().from(polls).where(eq(polls.id, pollId)).get();
  if (!poll) redirectWithError("/admin/polls", "Poll not found.");
  if (poll.status !== "draft") redirectWithError(`/admin/polls/${pollId}`, "Only a draft poll can be edited.");

  const parsed = validatePollForm(readPollFormInput(formData));
  if (!parsed.ok) redirectWithError(`/admin/polls/${pollId}`, parsed.error);

  db.transaction((tx) => {
    tx.update(polls)
      .set({
        question: parsed.value.question,
        description: parsed.value.description,
        kind: parsed.value.kind,
        anonymous: parsed.value.anonymous,
        allowWriteIn: parsed.value.allowWriteIn,
        closesAt: parsed.value.closesAt,
      })
      .where(eq(polls.id, pollId))
      .run();
    // Safe to wholesale-replace: a draft poll has never been open, so it can never have votes or
    // member-submitted write-in options yet — every existing option here is one the commissioner
    // themselves entered on create.
    tx.delete(pollOptions).where(eq(pollOptions.pollId, pollId)).run();
    parsed.value.options.forEach((label, i) => {
      tx.insert(pollOptions).values({ pollId, label, sort: i, isWriteIn: false }).run();
    });
  });

  redirect(`/admin/polls/${pollId}?success=saved`);
}

export async function openPollAction(formData: FormData): Promise<void> {
  await requireCommissioner();

  const pollId = Number(formData.get("pollId"));
  if (!Number.isInteger(pollId)) redirectWithError("/admin/polls", "Invalid poll.");

  const db = getDb();
  const poll = db.select().from(polls).where(eq(polls.id, pollId)).get();
  if (!poll) redirectWithError("/admin/polls", "Poll not found.");
  if (poll.status !== "draft") redirectWithError(`/admin/polls/${pollId}`, "Only a draft poll can be opened.");

  const optionCount = db.select().from(pollOptions).where(eq(pollOptions.pollId, pollId)).all().length;
  if (!poll.allowWriteIn && optionCount < 2) {
    redirectWithError(`/admin/polls/${pollId}`, "Add at least 2 options, or enable write-ins, before opening.");
  }

  db.update(polls).set({ status: "open" }).where(eq(polls.id, pollId)).run();
  redirect(`/admin/polls/${pollId}?success=opened`);
}

export async function closePollAction(formData: FormData): Promise<void> {
  await requireCommissioner();

  const pollId = Number(formData.get("pollId"));
  if (!Number.isInteger(pollId)) redirectWithError("/admin/polls", "Invalid poll.");

  const db = getDb();
  const poll = db.select().from(polls).where(eq(polls.id, pollId)).get();
  if (!poll) redirectWithError("/admin/polls", "Poll not found.");
  if (poll.status !== "open") redirectWithError(`/admin/polls/${pollId}`, "Only an open poll can be closed.");

  db.update(polls).set({ status: "closed" }).where(eq(polls.id, pollId)).run();
  redirect(`/admin/polls/${pollId}?success=closed`);
}

/** Draft-only — an open or closed poll may already carry real votes; deleting it would destroy
 * league decisions members already made. Deletes votes+options+the poll row in one transaction
 * (a draft poll should never actually have vote rows, but the delete is defensive/complete rather
 * than assuming that invariant holds). */
export async function deletePollAction(formData: FormData): Promise<void> {
  await requireCommissioner();

  const pollId = Number(formData.get("pollId"));
  if (!Number.isInteger(pollId)) redirectWithError("/admin/polls", "Invalid poll.");

  const db = getDb();
  const poll = db.select().from(polls).where(eq(polls.id, pollId)).get();
  if (!poll) redirectWithError("/admin/polls", "Poll not found.");
  if (poll.status !== "draft") redirectWithError(`/admin/polls/${pollId}`, "Only a draft poll can be deleted.");

  db.transaction((tx) => {
    tx.delete(pollVotes).where(eq(pollVotes.pollId, pollId)).run();
    tx.delete(pollOptions).where(eq(pollOptions.pollId, pollId)).run();
    tx.delete(polls).where(eq(polls.id, pollId)).run();
  });

  redirect("/admin/polls?success=deleted");
}
