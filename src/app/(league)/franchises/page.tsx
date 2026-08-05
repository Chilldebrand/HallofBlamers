import Link from "next/link";
import { PageHeader } from "@/components/broadcast/PageHeader";
import { SectionLabel } from "@/components/broadcast/SectionLabel";
import { formatPct, formatWLT } from "@/components/history/format";
import { getFranchiseIndex } from "@/server/queries/franchises";

export default function FranchisesPage() {
  const franchiseRows = getFranchiseIndex();
  const active = franchiseRows.filter((f) => f.active);
  const departed = franchiseRows.filter((f) => !f.active);

  return (
    <div className="flex flex-col gap-10">
      <PageHeader eyebrow="The Archive" title="Franchises" />

      <section className="flex flex-col gap-4">
        <SectionLabel>Active — {active.length}</SectionLabel>
        <div className="grid gap-4 sm:grid-cols-2">
          {active.map((f) => (
            <FranchiseCard key={f.id} franchise={f} />
          ))}
        </div>
      </section>

      {departed.length > 0 ? (
        <section className="flex flex-col gap-4">
          <SectionLabel>Departed — {departed.length}</SectionLabel>
          <div className="grid gap-4 sm:grid-cols-2">
            {departed.map((f) => (
              <FranchiseCard key={f.id} franchise={f} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function FranchiseCard({ franchise }: { franchise: ReturnType<typeof getFranchiseIndex>[number] }) {
  return (
    <Link href={`/franchises/${franchise.id}`} className="flex flex-col gap-3 border border-line-sheet bg-sheet p-5 transition-colors hover:border-ink">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="display text-[20px] uppercase text-ink">{franchise.name}</p>
          <p className="text-sm text-muted">{franchise.manager}</p>
        </div>
        <span className="display shrink-0 rounded-full border border-line-sheet-strong px-2 py-0.5 text-[10px] tracking-[0.16em] text-muted">
          {franchise.active ? "Active" : "Departed"}
        </span>
      </div>

      {franchise.championships > 0 ? <p className="display text-[11px] tracking-[0.16em] text-gold-ink">{franchise.championships}&times; Champion</p> : null}

      <div className="flex flex-wrap gap-x-6 gap-y-2 text-[14px]">
        <Stat label="Record" value={formatWLT(franchise.wins, franchise.losses, franchise.ties)} />
        <Stat label="Win %" value={formatPct(franchise.winPct)} />
        <Stat label="Elo" value={Math.round(franchise.currentElo)} />
        <Stat label="Belt Reigns" value={franchise.beltReignCount} />
      </div>
    </Link>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="inline-flex flex-col">
      <span className="display text-[10px] tracking-[0.16em] text-muted">{label}</span>
      <span className="font-semibold tabular-nums text-ink">{value}</span>
    </span>
  );
}
