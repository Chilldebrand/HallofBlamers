import Link from "next/link";
import { PageHeader } from "@/components/broadcast/PageHeader";
import { SectionHeading } from "@/components/league/SectionHeading";
import { SectionLabel } from "@/components/broadcast/SectionLabel";
import { weekTypeLabel } from "@/components/history/format";
import { getRecordBook } from "@/server/queries/records";

export default function RecordsPage() {
  const groups = getRecordBook();

  return (
    <div className="flex flex-col gap-12">
      <PageHeader eyebrow="History" title="Record Book" />

      {groups.map((group) => (
        <section key={group.group} className="flex flex-col gap-8">
          <SectionHeading>{group.groupLabel}</SectionHeading>
          <div className="flex flex-col gap-8">
            {group.sections.map((section) => {
              const top = section.rows[0];
              // Gold reserved for belt/champion elements — same gate as franchises/[id]'s
              // "Record Book Entries" section for the same underlying data.
              const gold = group.group === "belt" || group.group === "championship";
              return (
                <div key={section.key} className="flex flex-col gap-3">
                  <SectionLabel>{section.label}</SectionLabel>
                  {top ? (
                    <p className={`text-[17px] ${gold ? "text-gold-ink" : "text-ink"}`}>
                      <Link href={`/franchises/${top.franchiseId}`} className="hover:underline">
                        {top.franchiseName}
                      </Link>{" "}
                      <span className="tabular-nums text-[15px] text-muted">
                        {section.format(top.value)} · {top.season}
                        {top.week ? ` Wk ${top.week}` : ""}
                        {top.weekType ? ` · ${weekTypeLabel(top.weekType)}` : ""}
                      </span>
                    </p>
                  ) : (
                    <p className="text-sm text-muted">No entries yet.</p>
                  )}

                  {section.rows.length > 0 ? (
                    <div className="overflow-x-auto">
                      <div role="table" className="min-w-[520px]">
                        <div role="row" className="grid grid-cols-[40px_1fr_120px_180px] border-b border-line-sheet-strong pb-2">
                          {["#", "Franchise", "Value", "When"].map((h, i) => (
                            <span key={h} role="columnheader" className={`display text-[11px] tracking-[0.14em] text-muted ${i > 1 ? "text-right" : ""}`}>
                              {h}
                            </span>
                          ))}
                        </div>
                        {section.rows.map((row, i) => (
                          <div
                            key={`${row.franchiseId}-${row.season}-${row.week}-${i}`}
                            role="row"
                            className="grid grid-cols-[40px_1fr_120px_180px] items-center border-b border-line-sheet-soft py-2.5 text-[14px] last:border-b-0"
                          >
                            <span role="cell" className="tabular-nums text-muted">{row.rank}</span>
                            <span role="cell" className="text-ink">
                              <Link href={`/franchises/${row.franchiseId}`} className="hover:underline">
                                {row.franchiseName}
                              </Link>
                            </span>
                            <span role="cell" className="text-right tabular-nums text-ink">{section.format(row.value)}</span>
                            <span role="cell" className="text-right tabular-nums text-muted">
                              {row.season}
                              {row.week ? ` Wk ${row.week}` : ""}
                              {row.weekType ? <span className="ml-2 rounded-full border border-line-sheet-strong px-1.5 py-0.5 text-[10px] tracking-wide">{weekTypeLabel(row.weekType)}</span> : null}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
