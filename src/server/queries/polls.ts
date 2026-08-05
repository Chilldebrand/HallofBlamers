import { and, asc, count, desc, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { managers, pollOptions, pollVotes, polls, type Poll, type PollOption } from "../db/schema";

// ---------------------------------------------------------------------------
// Pure: write-in dedupe
// ---------------------------------------------------------------------------

/** Case-insensitive, trimmed comparison key — "Saturday" and "saturday " dedupe to the same
 * option. Pure — unit-tested directly. */
export function normalizeLabelForDedupe(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * Finds an existing option (write-in OR regular) whose label matches `candidateLabel`
 * case-insensitively. Deliberately checks ALL options, not just prior write-ins — a write-in of
 * "saturday" against an existing REGULAR option "Saturday" should vote for the existing option,
 * not fragment the count with a redundant near-duplicate. Pure — unit-tested directly.
 */
export function findMatchingOption<T extends { label: string }>(options: T[], candidateLabel: string): T | undefined {
  const normalized = normalizeLabelForDedupe(candidateLabel);
  return options.find((o) => normalizeLabelForDedupe(o.label) === normalized);
}

// ---------------------------------------------------------------------------
// Pure: results aggregation
// ---------------------------------------------------------------------------

export interface PollOptionResult {
  optionId: number;
  label: string;
  isWriteIn: boolean;
  sort: number;
  voteCount: number;
  /** 0-100, of distinct voters (not distinct votes — a multi-choice poll's percentages don't sum
   * to 100). 0 when nobody has voted yet, never NaN. */
  pct: number;
}

export interface PollVoterBreakdownRow {
  managerId: number;
  optionIds: number[];
}

export interface PollResultsCore {
  options: PollOptionResult[];
  totalVoters: number;
  nonVoterManagerIds: number[];
  /** Null whenever `anonymous` is true — the pure function never computes this in that case, so
   * there's no per-voter data to accidentally leak downstream, not merely a UI hiding trick. */
  perVoterBreakdown: PollVoterBreakdownRow[] | null;
}

/**
 * Aggregates raw vote rows into counts/percentages/non-voters/(optional) per-voter breakdown.
 * Pure — unit-tested directly against fixture rows. The DB-facing `getPollResults` below supplies
 * real rows and layers manager/option names on top.
 */
export function computePollResults(
  options: { id: number; label: string; sort: number; isWriteIn: boolean }[],
  voteRows: { optionId: number; managerId: number }[],
  allManagerIds: number[],
  anonymous: boolean,
): PollResultsCore {
  const votersSet = new Set(voteRows.map((v) => v.managerId));
  const totalVoters = votersSet.size;

  const countByOption = new Map<number, number>();
  for (const v of voteRows) countByOption.set(v.optionId, (countByOption.get(v.optionId) ?? 0) + 1);

  const optionResults: PollOptionResult[] = [...options]
    .sort((a, b) => a.sort - b.sort)
    .map((o) => {
      const voteCount = countByOption.get(o.id) ?? 0;
      return { optionId: o.id, label: o.label, isWriteIn: o.isWriteIn, sort: o.sort, voteCount, pct: totalVoters > 0 ? (voteCount / totalVoters) * 100 : 0 };
    });

  const nonVoterManagerIds = allManagerIds.filter((id) => !votersSet.has(id));

  let perVoterBreakdown: PollVoterBreakdownRow[] | null = null;
  if (!anonymous) {
    const byManager = new Map<number, number[]>();
    for (const v of voteRows) {
      const list = byManager.get(v.managerId) ?? [];
      list.push(v.optionId);
      byManager.set(v.managerId, list);
    }
    perVoterBreakdown = [...byManager.entries()].map(([managerId, optionIds]) => ({ managerId, optionIds }));
  }

  return { options: optionResults, totalVoters, nonVoterManagerIds, perVoterBreakdown };
}

// ---------------------------------------------------------------------------
// DB reads
// ---------------------------------------------------------------------------

/** Cheap — a single COUNT query, no row materialization. Drives the home page card and (if ever
 * added) a nav badge. */
export function getOpenPollCount(): number {
  const db = getDb();
  const row = db.select({ value: count() }).from(polls).where(eq(polls.status, "open")).get();
  return row?.value ?? 0;
}

export function getPollsByStatus(status: Poll["status"]): Poll[] {
  const db = getDb();
  return db.select().from(polls).where(eq(polls.status, status)).orderBy(desc(polls.createdAt), desc(polls.id)).all();
}

export function getAllPolls(): Poll[] {
  const db = getDb();
  return db.select().from(polls).orderBy(desc(polls.createdAt), desc(polls.id)).all();
}

export function getPollById(id: number): Poll | null {
  const db = getDb();
  return db.select().from(polls).where(eq(polls.id, id)).get() ?? null;
}

export function getPollOptions(pollId: number): PollOption[] {
  const db = getDb();
  return db.select().from(pollOptions).where(eq(pollOptions.pollId, pollId)).orderBy(asc(pollOptions.sort), asc(pollOptions.id)).all();
}

/** The option ids the given manager currently has votes for in this poll — drives the "my vote"
 * pre-selected state on the vote form and the "already voted" badge in list views. */
export function getMyVotedOptionIds(pollId: number, managerId: number): number[] {
  const db = getDb();
  return db
    .select({ optionId: pollVotes.optionId })
    .from(pollVotes)
    .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.managerId, managerId)))
    .all()
    .map((r) => r.optionId);
}

export interface PollResultsView extends Omit<PollResultsCore, "perVoterBreakdown" | "nonVoterManagerIds"> {
  nonVoters: { managerId: number; name: string }[];
  /** Null for an anonymous poll — see `computePollResults`'s docstring; enforced at the QUERY
   * layer, not just the page, so an anonymous poll's per-voter identities are never fetched into
   * a shape a page could accidentally render, for members OR the commissioner. */
  perVoterBreakdown: { managerId: number; name: string; optionIds: number[] }[] | null;
}

/** Full results for one poll — counts/percentages, non-voters (always visible to the commissioner
 * so they can nag), and a per-voter breakdown ONLY when the poll isn't anonymous. */
export function getPollResults(pollId: number): PollResultsView | null {
  const db = getDb();
  const poll = db.select().from(polls).where(eq(polls.id, pollId)).get();
  if (!poll) return null;

  const options = getPollOptions(pollId);
  const voteRows = db.select({ optionId: pollVotes.optionId, managerId: pollVotes.managerId }).from(pollVotes).where(eq(pollVotes.pollId, pollId)).all();
  const allManagers = db.select({ id: managers.id, name: managers.name }).from(managers).all();
  const nameById = new Map(allManagers.map((m) => [m.id, m.name]));

  const core = computePollResults(options, voteRows, allManagers.map((m) => m.id), poll.anonymous);

  return {
    options: core.options,
    totalVoters: core.totalVoters,
    nonVoters: core.nonVoterManagerIds.map((id) => ({ managerId: id, name: nameById.get(id) ?? `Manager ${id}` })),
    perVoterBreakdown: core.perVoterBreakdown ? core.perVoterBreakdown.map((r) => ({ ...r, name: nameById.get(r.managerId) ?? `Manager ${r.managerId}` })) : null,
  };
}
