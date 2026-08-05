import Link from "next/link";
import { Button, Notice } from "@/components/broadcast/FormControls";
import { PageHeader } from "@/components/broadcast/PageHeader";
import { SectionLabel } from "@/components/broadcast/SectionLabel";
import { requireCommissioner } from "@/server/auth/guard";
import { createPollAction } from "@/features/polls/actions";
import { getAllPolls } from "@/server/queries/polls";

const MIN_OPTION_ROWS = 4;

export default async function AdminPollsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  // Commissioner-only mutation surface — gate the page itself, not just the (league) layout (see
  // src/features/polls/actions.ts's docstring).
  await requireCommissioner();

  const params = await searchParams;
  const pollRows = getAllPolls();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader eyebrow="Commissioner" title="Polls & Surveys" />

      {params.error ? <Notice tone="live">{params.error}</Notice> : null}

      <section className="flex flex-col gap-4">
        <SectionLabel>Create a Poll</SectionLabel>
        <form action={createPollAction} className="flex flex-col gap-4 border border-line-sheet bg-sheet p-5">
          <label className="flex flex-col gap-1">
            <span className="display text-[10px] tracking-[0.16em] text-muted">Question</span>
            <input type="text" name="question" required className="border border-line-sheet bg-sheet px-3 py-2 text-sm text-ink" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="display text-[10px] tracking-[0.16em] text-muted">Description (optional)</span>
            <textarea name="description" rows={2} className="border border-line-sheet bg-sheet px-3 py-2 text-sm text-ink" />
          </label>

          <div className="flex flex-wrap gap-4">
            <label className="flex flex-col gap-1">
              <span className="display text-[10px] tracking-[0.16em] text-muted">Kind</span>
              <select name="kind" defaultValue="single" className="border border-line-sheet bg-sheet px-3 py-2 text-sm text-ink">
                <option value="single">Single choice</option>
                <option value="multi">Multiple choice</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="display text-[10px] tracking-[0.16em] text-muted">Closes (optional)</span>
              <input type="date" name="closesAt" className="border border-line-sheet bg-sheet px-3 py-2 text-sm text-ink" />
            </label>
          </div>

          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" name="anonymous" className="h-4 w-4" />
              Anonymous (votes hidden from everyone, including you — totals only)
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" name="allowWriteIn" className="h-4 w-4" />
              Allow write-in answers
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <span className="display text-[10px] tracking-[0.16em] text-muted">Options (min 2, unless write-ins are allowed)</span>
            {Array.from({ length: MIN_OPTION_ROWS }).map((_, i) => (
              <input key={i} type="text" name="option" placeholder={`Option ${i + 1}`} className="border border-line-sheet bg-sheet px-3 py-2 text-sm text-ink" />
            ))}
          </div>

          <div>
            <Button>Create Draft</Button>
          </div>
        </form>
      </section>

      <section className="flex flex-col gap-4">
        <SectionLabel>All Polls</SectionLabel>
        <div className="flex flex-col gap-2">
          {pollRows.map((p) => (
            <Link key={p.id} href={`/admin/polls/${p.id}`} className="flex items-center justify-between gap-4 border border-line-sheet bg-sheet px-4 py-3 transition-colors hover:border-ink">
              <span className="text-ink">{p.question}</span>
              <span className="flex items-center gap-3 text-xs text-muted">
                {p.anonymous ? <span>anonymous</span> : null}
                <span>{p.status}</span>
              </span>
            </Link>
          ))}
          {pollRows.length === 0 ? <p className="border border-line-sheet bg-sheet p-6 text-sm text-muted">No polls yet — create one above.</p> : null}
        </div>
      </section>
    </div>
  );
}
