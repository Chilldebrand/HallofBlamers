import { notFound } from "next/navigation";
import { Button, Notice } from "@/components/broadcast/FormControls";
import { PageHeader } from "@/components/broadcast/PageHeader";
import { SectionLabel } from "@/components/broadcast/SectionLabel";
import { requireCommissioner } from "@/server/auth/guard";
import { closePollAction, deletePollAction, openPollAction, updatePollAction } from "@/features/polls/actions";
import { getPollById, getPollOptions, getPollResults } from "@/server/queries/polls";

const MIN_EXTRA_OPTION_ROWS = 2;

export default async function AdminPollDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  await requireCommissioner();

  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isInteger(id)) notFound();

  const poll = getPollById(id);
  if (!poll) notFound();

  const { error, success } = await searchParams;
  const options = getPollOptions(id);
  const results = poll.status !== "draft" ? getPollResults(id) : null;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader eyebrow={`${poll.status}${poll.anonymous ? " · anonymous" : ""}`} title={poll.question} />

      {error ? <Notice tone="live">{error}</Notice> : null}
      {success ? <Notice tone="kelly">Poll {success}.</Notice> : null}

      {poll.description ? <p className="text-sm text-muted">{poll.description}</p> : null}
      {poll.closesAt ? <p className="text-xs text-muted">Closes {poll.closesAt.toISOString().slice(0, 10)}.</p> : null}

      {poll.status === "draft" ? (
        <section className="flex flex-col gap-4">
          <SectionLabel>Edit Draft</SectionLabel>
          <form action={updatePollAction} className="flex flex-col gap-4 border border-line-sheet bg-sheet p-5">
            <input type="hidden" name="pollId" value={poll.id} />
            <label className="flex flex-col gap-1">
              <span className="display text-[10px] tracking-[0.16em] text-muted">Question</span>
              <input type="text" name="question" defaultValue={poll.question} required className="border border-line-sheet bg-sheet px-3 py-2 text-sm text-ink" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="display text-[10px] tracking-[0.16em] text-muted">Description (optional)</span>
              <textarea name="description" defaultValue={poll.description ?? ""} rows={2} className="border border-line-sheet bg-sheet px-3 py-2 text-sm text-ink" />
            </label>

            <div className="flex flex-wrap gap-4">
              <label className="flex flex-col gap-1">
                <span className="display text-[10px] tracking-[0.16em] text-muted">Kind</span>
                <select name="kind" defaultValue={poll.kind} className="border border-line-sheet bg-sheet px-3 py-2 text-sm text-ink">
                  <option value="single">Single choice</option>
                  <option value="multi">Multiple choice</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="display text-[10px] tracking-[0.16em] text-muted">Closes (optional)</span>
                <input type="date" name="closesAt" defaultValue={poll.closesAt ? poll.closesAt.toISOString().slice(0, 10) : ""} className="border border-line-sheet bg-sheet px-3 py-2 text-sm text-ink" />
              </label>
            </div>

            <div className="flex flex-wrap gap-6">
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" name="anonymous" defaultChecked={poll.anonymous} className="h-4 w-4" />
                Anonymous (votes hidden from everyone, including you — totals only)
              </label>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" name="allowWriteIn" defaultChecked={poll.allowWriteIn} className="h-4 w-4" />
                Allow write-in answers
              </label>
            </div>

            <div className="flex flex-col gap-2">
              <span className="display text-[10px] tracking-[0.16em] text-muted">Options (min 2, unless write-ins are allowed)</span>
              {options.map((o) => (
                <input key={o.id} type="text" name="option" defaultValue={o.label} className="border border-line-sheet bg-sheet px-3 py-2 text-sm text-ink" />
              ))}
              {Array.from({ length: MIN_EXTRA_OPTION_ROWS }).map((_, i) => (
                <input key={`extra-${i}`} type="text" name="option" placeholder="Add an option" className="border border-line-sheet bg-sheet px-3 py-2 text-sm text-ink" />
              ))}
            </div>

            <div>
              <Button>Save Draft</Button>
            </div>
          </form>

          <div className="flex flex-wrap gap-3">
            <form action={openPollAction}>
              <input type="hidden" name="pollId" value={poll.id} />
              <Button>Open for Voting</Button>
            </form>
            <form action={deletePollAction}>
              <input type="hidden" name="pollId" value={poll.id} />
              <Button className="text-muted hover:text-ink">Delete Draft</Button>
            </form>
          </div>
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

          {results.perVoterBreakdown ? (
            <div className="border border-line-sheet bg-sheet p-5">
              <p className="display mb-2 text-[10px] tracking-[0.16em] text-muted">Per-Voter Breakdown</p>
              <ul className="flex flex-col gap-1 text-sm text-ink">
                {results.perVoterBreakdown.map((v) => (
                  <li key={v.managerId}>
                    {v.name} — {v.optionIds.map((oid) => results.options.find((o) => o.optionId === oid)?.label ?? "—").join(", ")}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <Notice tone="ink">Individual votes are hidden — only totals are shown, for everyone including you.</Notice>
          )}

          <div className="border border-line-sheet bg-sheet p-5">
            <p className="display mb-2 text-[10px] tracking-[0.16em] text-muted">Hasn&apos;t Voted Yet ({results.nonVoters.length})</p>
            {results.nonVoters.length > 0 ? (
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
                {results.nonVoters.map((m) => (
                  <li key={m.managerId}>{m.name}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Everyone has voted.</p>
            )}
          </div>

          {poll.status === "open" ? (
            <form action={closePollAction}>
              <input type="hidden" name="pollId" value={poll.id} />
              <Button>Close Poll</Button>
            </form>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
