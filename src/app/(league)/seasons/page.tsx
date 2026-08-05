import Link from "next/link";
import { PageHeader } from "@/components/broadcast/PageHeader";
import { getSeasonIndex } from "@/server/queries/seasons";

export default function SeasonsPage() {
  const seasonRows = getSeasonIndex();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader eyebrow="History" title="Seasons" />
      <div className="grid gap-4 sm:grid-cols-2">
        {seasonRows.map((s) => (
          <Link key={s.season} href={`/seasons/${s.season}`} className="flex flex-col gap-3 border border-line-sheet bg-sheet p-5 transition-colors hover:border-ink">
            <div className="flex items-center justify-between">
              <p className="display text-[32px] leading-none text-ink">{s.season}</p>
              <span className="display rounded-full border border-line-sheet-strong px-2 py-0.5 text-[10px] tracking-[0.16em] text-muted">{s.teamCount} Teams</span>
            </div>

            {s.champion ? (
              <p className="text-[15px] text-ink">
                <span className="display text-[11px] tracking-[0.18em] text-gold-ink">Champion </span>
                {s.champion.name}
              </p>
            ) : (
              <p className="text-[15px] text-muted">{s.status === "upcoming" ? "Draft not yet held" : "In progress"}</p>
            )}

            <div className="flex flex-wrap gap-x-6 gap-y-2 text-[14px]">
              {s.runnerUp ? <Stat label="Runner-Up" value={s.runnerUp.name} /> : null}
              {s.sacko ? <Stat label="Sacko" value={s.sacko.name} /> : null}
              {s.highestWeek ? <Stat label="Highest Week" value={`${s.highestWeek.value.toFixed(1)} (${s.highestWeek.franchiseName})`} /> : null}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex flex-col">
      <span className="display text-[10px] tracking-[0.16em] text-muted">{label}</span>
      <span className="text-ink">{value}</span>
    </span>
  );
}
