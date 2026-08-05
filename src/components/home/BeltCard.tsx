import Link from "next/link";
import { FranchiseName, type FranchiseNameFranchise } from "@/components/league/FranchiseName";
import { cn } from "@/components/ui/cn";
import type { CurrentReignDetail } from "@/server/queries/belt";
import { computeDefensePips } from "@/server/queries/homepage";
import type { IdentityFlags } from "@/server/queries/identity";
import { resolveFranchiseFlags } from "@/server/queries/identity";

export interface BeltCardProps {
  reign: CurrentReignDetail | null;
  flags: IdentityFlags;
}

/** Rail's belt card (README "2. Home" — rail): 44×20 mark + name, defense pips, detail line. */
export function BeltCard({ reign, flags }: BeltCardProps) {
  if (!reign) {
    return (
      <div className="border-b border-line bg-chrome px-6 py-6 md:px-7">
        <div className="display text-[11px] tracking-[0.22em] text-muted-on-chrome">The Belt</div>
        <p className="mt-2 text-sm text-muted-on-chrome">Vacant — nobody currently holds it.</p>
      </div>
    );
  }

  const franchise: FranchiseNameFranchise = { id: reign.franchiseId, name: reign.franchiseName, ...resolveFranchiseFlags(flags, reign.franchiseId) };
  const { total, filled } = computeDefensePips(reign.defenses);

  return (
    <Link href="/belt" className="block border-b border-line bg-chrome px-6 py-6 transition-colors hover:bg-chrome-raised/40 md:px-7">
      <div className="display text-[11px] tracking-[0.22em] text-gold-ink">The Belt · Reign {reign.reignNo}</div>
      <div className="mt-2 flex items-center gap-3">
        <FranchiseName franchise={franchise} size="beltCard" surfaceBehind="var(--color-chrome)" className="display text-[26px] text-ink-on-chrome md:text-[32px]" />
      </div>
      <div className="mt-3 flex gap-[3px]">
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={cn("h-1.5 flex-1", i < filled ? "bg-gold-fill" : "bg-line")} />
        ))}
      </div>
      <div className="mt-2 text-[13px] text-muted-on-chrome">
        {reign.defenses} defense{reign.defenses === 1 ? "" : "s"} · {reign.weeksHeld} week{reign.weeksHeld === 1 ? "" : "s"} held
        {reign.wonFromName ? ` · took it from ${reign.wonFromName}, ${reign.startSeason} Wk ${reign.startWeek}` : ""}
      </div>
    </Link>
  );
}
