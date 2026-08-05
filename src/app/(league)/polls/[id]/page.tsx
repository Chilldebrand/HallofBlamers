import { notFound } from "next/navigation";
import { Notice } from "@/components/broadcast/FormControls";
import { PageHeader } from "@/components/broadcast/PageHeader";
import { SectionLabel } from "@/components/broadcast/SectionLabel";
import { requireManager } from "@/server/auth/guard";
import { submitVoteAction } from "@/features/polls/vote-actions";
import { getMyVotedOptionIds, getPollById, getPollOptions, getPollResults } from "@/server/queries/polls";

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatCloses(date: Date): string {
  return `closes ${MONTH_LABELS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

export default async function PollDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const manager = await requireManager();

  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isInteger(id)) notFound();

  const poll = getPollById(id);
  // Draft polls are commissioner-only previews — never visible on the member side.
  if (!poll || poll.status === "draft") notFound();

  const { error, success } = await searchParams;
  const options = getPollOptions(id);
  const myVotedOptionIds = new Set(getMyVotedOptionIds(id, manager.id));
  // Results are always visible for an open poll (this is a league decision tool, not a secret
  // ballot) — "live" simply means they reflect every vote as soon as it's cast, including your
  // own the moment you submit. Closed polls: results only, no form at all.
  const results = getPollResults(id);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader eyebrow={`${poll.status}${poll.anonymous ? " · anonymous" : ""}`} title={poll.question} />

      {error ? <Notice tone="live">{error}</Notice> : null}
      {success === "voted" ? <Notice tone="kelly">Your vote has been saved.</Notice> : null}

      {poll.description ? <p className="text-sm text-muted">{poll.description}</p> : null}
      {poll.closesAt ? <p className="text-xs text-muted">{formatCloses(poll.closesAt)}.</p> : null}

      {poll.status === "open" ? (
        <section className="flex flex-col gap-4">
          <SectionLabel>{myVotedOptionIds.size > 0 ? "Change Your Vote" : "Cast Your Vote"}</SectionLabel>
          <form action={submitVoteAction} className="flex flex-col gap-4 border border-line-sheet bg-sheet p-5">
            <input type="hidden" name="pollId" value={poll.id} />
            <div className="flex flex-col gap-2">
              {options.map((o) => (
                <label key={o.id} className="flex items-center gap-2 text-sm text-ink">
                  <input type={poll.kind === "single" ? "radio" : "checkbox"} name="optionId" value={o.id} defaultChecked={myVotedOptionIds.has(o.id)} className="h-4 w-4" />
                  {o.label}
                </label>
              ))}
            </div>
            {poll.allowWriteIn ? (
              <label className="flex flex-col gap-1">
                <span className="display text-[10px] tracking-[0.16em] text-muted">Write in your own answer (optional)</span>
                <input type="text" name="writeInLabel" className="border border-line-sheet bg-sheet px-3 py-2 text-sm text-ink" />
              </label>
            ) : null}
            <div>
              <button type="submit" className="display border border-line-sheet-strong px-4 py-2 text-xs tracking-[0.12em] text-ink hover:border-ink">
                Submit Vote
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {results ? (
        <section className="flex flex-col gap-4">
          <SectionLabel>Results — {results.totalVoters} voted</SectionLabel>
          <div className="flex flex-col gap-3 border border-line-sheet bg-sheet p-5">
            {results.options.map((o) => (
              <div key={o.optionId} className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-ink">
                    {o.label}
                    {o.isWriteIn ? <span className="ml-2 text-[10px] text-muted">write-in</span> : null}
                  </span>
                  <span className="tabular-nums text-muted">
                    {o.voteCount} ({o.pct.toFixed(0)}%)
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden bg-line-sheet">
                  <div className="h-full bg-kelly" style={{ width: `${Math.min(o.pct, 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
          {poll.anonymous ? <Notice tone="ink">Individual votes are hidden — only totals are shown.</Notice> : null}
        </section>
      ) : null}
    </div>
  );
}
