import Link from "next/link";
import { PageHeader } from "@/components/broadcast/PageHeader";
import { SectionLabel } from "@/components/broadcast/SectionLabel";
import { requireManager } from "@/server/auth/guard";
import { getMyVotedOptionIds, getPollsByStatus } from "@/server/queries/polls";

export default async function PollsIndexPage() {
  const manager = await requireManager();

  const openPolls = getPollsByStatus("open");
  const closedPolls = getPollsByStatus("closed");

  return (
    <div className="flex flex-col gap-8">
      <PageHeader eyebrow="League" title="Polls & Surveys" />

      <section className="flex flex-col gap-4">
        <SectionLabel>Open Polls</SectionLabel>
        {openPolls.length === 0 ? (
          <p className="border border-line-sheet bg-sheet p-6 text-sm text-muted">No polls are open right now.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {openPolls.map((p) => {
              const myVotes = getMyVotedOptionIds(p.id, manager.id);
              return (
                <Link key={p.id} href={`/polls/${p.id}`} className="flex items-center justify-between gap-4 border border-line-sheet bg-sheet px-4 py-3 transition-colors hover:border-ink">
                  <span className="text-ink">{p.question}</span>
                  <span className="display text-[11px] tracking-[0.14em] text-muted">{myVotes.length > 0 ? "Voted" : "Vote Now"}</span>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <SectionLabel>Closed Polls</SectionLabel>
        {closedPolls.length === 0 ? (
          <p className="text-sm text-muted">No closed polls yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {closedPolls.map((p) => (
              <Link key={p.id} href={`/polls/${p.id}`} className="flex items-center justify-between gap-4 border border-line-sheet bg-sheet px-4 py-3 transition-colors hover:border-ink">
                <span className="text-ink">{p.question}</span>
                <span className="display text-[11px] tracking-[0.14em] text-muted">Results</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {openPolls.length === 0 && closedPolls.length === 0 ? (
        <div className="border border-line-sheet bg-sheet p-4">
          <p className="display text-[11px] tracking-[0.18em] text-muted">Polls</p>
          <p className="mt-1 text-[15px] text-ink">The commissioner hasn&apos;t opened any polls yet.</p>
        </div>
      ) : null}
    </div>
  );
}
