import Link from "next/link";
import { FranchiseName, type FranchiseNameFranchise } from "@/components/league/FranchiseName";
import { cn } from "@/components/ui/cn";
import type { PowerLadder as PowerLadderData, PowerLadderRow } from "@/server/queries/homepage";
import type { IdentityFlags } from "@/server/queries/identity";
import { resolveFranchiseFlags } from "@/server/queries/identity";

export interface PowerLadderProps {
  ladder: PowerLadderData;
  flags: IdentityFlags;
}

/**
 * Rail's power ladder (README "2. Home" — rail): rank / name / delta-vs-prior-week / Elo, full
 * identity treatment (champion gold, belt mark, your row raised + "· you"). Desktop shows all
 * rows fetched (8, per the brief); phone trims to 4 with an "All N →" link — N is the REAL active
 * franchise count (ladder.totalActive), never a hardcoded "twelve".
 */
export function PowerLadder({ ladder, flags }: PowerLadderProps) {
  return (
    <div className="px-6 py-6 md:px-7">
      <div className="flex items-baseline justify-between border-b border-line pb-2.5">
        <span className="display text-lg tracking-[0.08em] text-ink-on-chrome md:text-xl">Power Ladder</span>
        <span className="display text-[10px] tracking-[0.16em] text-muted-on-chrome md:text-[11px]">Elo</span>
      </div>
      <LadderRows rows={ladder.rows} flags={flags} className="hidden md:block" />
      <LadderRows rows={ladder.rows.slice(0, 4)} flags={flags} className="md:hidden" />
      <Link href="/franchises" className="display mt-3 inline-block text-xs tracking-[0.14em] text-kelly-bright md:text-[13px]">
        All {ladder.totalActive} →
      </Link>
    </div>
  );
}

function LadderRows({ rows, flags, className }: { rows: PowerLadderRow[]; flags: IdentityFlags; className?: string }) {
  return (
    <div className={className}>
      {rows.map((row, i) => {
        const rowFlags = resolveFranchiseFlags(flags, row.franchiseId);
        const franchise: FranchiseNameFranchise = { id: row.franchiseId, name: row.name, ...rowFlags };
        const surface = rowFlags.isViewer ? "var(--color-chrome-raised)" : "var(--color-chrome)";
        return (
          <div
            key={row.franchiseId}
            className={cn(
              "flex items-center gap-2.5 py-2.5 md:gap-3",
              i < rows.length - 1 ? "border-b border-line-soft" : undefined,
              rowFlags.isViewer ? "bg-chrome-raised" : undefined,
            )}
          >
            <span className="display w-5 shrink-0 text-base text-muted-on-chrome">{row.rank}</span>
            <FranchiseName franchise={franchise} size="row" surfaceBehind={surface} className="min-w-0 flex-1 text-sm text-ink-on-chrome" />
            <DeltaLabel delta={row.delta} />
            <span className="display w-[42px] shrink-0 text-right text-base text-ink-on-chrome md:text-[17px]">{Math.round(row.elo)}</span>
          </div>
        );
      })}
    </div>
  );
}

function DeltaLabel({ delta }: { delta: number | null }) {
  if (delta === null) return <span className="w-[34px] shrink-0 text-right text-xs text-muted-on-chrome">—</span>;
  const rounded = Math.round(delta);
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  const color = rounded > 0 ? "text-kelly-bright" : rounded < 0 ? "text-live" : "text-muted-on-chrome";
  return (
    <span className={cn("w-[34px] shrink-0 text-right text-xs tabular-nums", color)}>
      {sign}
      {Math.abs(rounded)}
    </span>
  );
}
