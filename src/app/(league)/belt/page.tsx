import Link from "next/link";
import { BeltMark } from "@/components/league/FranchiseName";
import { PageHeader } from "@/components/broadcast/PageHeader";
import { SectionLabel } from "@/components/broadcast/SectionLabel";
import { endReasonLabel, formatSpan } from "@/components/history/format";
import { ReplayBeltTransferButton } from "@/features/live/ReplayBeltTransferButton";
import { getBeltLineage, getBeltRecords, getCurrentReignDetail } from "@/server/queries/belt";

export default function BeltPage() {
  const current = getCurrentReignDetail();
  const lineage = getBeltLineage();
  const records = getBeltRecords();

  return (
    <div className="flex flex-col gap-10">
      <PageHeader eyebrow="Championship Lineage" title="The Belt" />

      <section className="border border-line-sheet-strong border-l-[3px] border-l-gold-fill bg-sheet-raised p-6">
        {current ? (
          <>
            <div className="flex items-center gap-2.5">
              <BeltMark size="heading" surfaceBehind="var(--color-sheet-raised)" />
              <p className="display text-[12px] tracking-[0.2em] text-gold-ink">Current Holder</p>
            </div>
            <p className="mt-1.5 text-[20px] text-ink">
              <Link href={`/franchises/${current.franchiseId}`} className="hover:underline">
                {current.franchiseName}
              </Link>
            </p>
            <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
              <Stat label="Reign No." value={`#${current.reignNo}`} gold />
              <Stat label="Weeks Held" value={current.weeksHeld} />
              <Stat label="Defenses" value={current.defenses} />
              <Stat label="Since" value={`${current.startSeason} Wk ${current.startWeek}`} />
            </div>
            {current.wonFromName ? (
              <>
                <p className="mt-4 text-[15px] text-muted">
                  Won from{" "}
                  <Link href="/franchises" className="hover:underline">
                    {current.wonFromName}
                  </Link>
                  {current.wonFromScore !== null && current.holderWinScore !== null ? ` — ${current.holderWinScore.toFixed(1)} to ${current.wonFromScore.toFixed(1)}` : ""}.
                </p>
                <div className="mt-4">
                  <ReplayBeltTransferButton
                    data={{
                      newHolderName: current.franchiseName,
                      previousHolderName: current.wonFromName,
                      newHolderScore: current.holderWinScore,
                      previousHolderScore: current.wonFromScore,
                    }}
                  />
                </div>
              </>
            ) : (
              <p className="mt-4 text-[15px] text-muted">Awarded into a vacant title.</p>
            )}
          </>
        ) : (
          <p className="text-[15px] text-muted">The belt is currently vacant.</p>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <SectionLabel>Belt Records</SectionLabel>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="border border-line-sheet bg-sheet p-5">
            <p className="display text-[11px] tracking-[0.18em] text-muted">Most Reigns</p>
            <p className="mt-1.5 text-[17px] text-ink">{records.mostReigns ? `${records.mostReigns.name} — ${records.mostReigns.count}` : "—"}</p>
          </div>
          <div className="border border-line-sheet bg-sheet p-5">
            <p className="display text-[11px] tracking-[0.18em] text-muted">Longest Reign</p>
            <p className="mt-1.5 text-[17px] text-ink">{records.longestReign ? `${records.longestReign.name} — ${records.longestReign.weeksHeld} weeks` : "—"}</p>
          </div>
          <div className="border border-line-sheet bg-sheet p-5">
            <p className="display text-[11px] tracking-[0.18em] text-muted">Most Career Defenses</p>
            <p className="mt-1.5 text-[17px] text-ink">{records.mostDefenses ? `${records.mostDefenses.name} — ${records.mostDefenses.defenses}` : "—"}</p>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <SectionLabel>Complete Lineage — {lineage.length} Reigns</SectionLabel>
        <div className="overflow-x-auto">
          <div role="table" className="min-w-[680px]">
            <div role="row" className="grid grid-cols-[60px_1fr_1fr_1fr_90px_1fr] border-b-2 border-ink pb-2.5">
              {["#", "Holder", "Taken From", "Span", "Defenses", "End"].map((h, i) => (
                <span key={h} role="columnheader" className={`display text-[11px] tracking-[0.16em] text-muted ${i === 4 ? "text-right" : ""}`}>
                  {h}
                </span>
              ))}
            </div>
            {lineage.map((r) => (
              <div
                key={r.reignNo}
                role="row"
                className={`grid grid-cols-[60px_1fr_1fr_1fr_90px_1fr] items-center border-b border-line-sheet py-3 text-[14px] last:border-b-0 ${r.isCurrent ? "bg-sheet-raised" : ""}`}
              >
                <span role="cell" className={`tabular-nums ${r.isCurrent ? "text-gold-ink" : "text-muted"}`}>#{r.reignNo}</span>
                <span role="cell" className="text-ink">
                  <Link href={`/franchises/${r.holderId}`} className="hover:underline">
                    {r.holderName}
                  </Link>
                </span>
                <span role="cell" className="text-muted">{r.wonFromName ?? "Vacancy"}</span>
                <span role="cell" className="tabular-nums text-ink">{formatSpan(r.startSeason, r.startWeek, r.endSeason, r.endWeek)}</span>
                <span role="cell" className="text-right tabular-nums text-muted">{r.defenses}</span>
                <span role="cell" className="text-muted">{r.isCurrent ? <span className="text-gold-ink">Current</span> : endReasonLabel(r.endReason)}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, gold = false }: { label: string; value: string | number; gold?: boolean }) {
  return (
    <span className="inline-flex flex-col">
      <span className="display text-[10px] tracking-[0.16em] text-muted">{label}</span>
      <span className={`font-semibold tabular-nums ${gold ? "text-gold-ink" : "text-ink"}`}>{value}</span>
    </span>
  );
}
