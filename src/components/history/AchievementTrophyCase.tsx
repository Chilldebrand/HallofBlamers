import type { FranchiseAchievementGroup } from "@/server/queries/achievements";

/**
 * Franchise profile's trophy case (Task 33 wiring wave, brief item 3) — grid of every achievement
 * type this franchise has earned at least once, with a career count + most recent occurrence.
 * Ink/kelly grammar only, deliberately — per the brief, achievements are NOT belt contexts, so
 * gold (reserved for champion/belt identity, see FranchiseName.tsx) never appears here even for
 * the belt-flavored `belt_thief`/`belt_defender` keys.
 */
export function AchievementTrophyCase({ groups }: { groups: FranchiseAchievementGroup[] }) {
  if (groups.length === 0) {
    return <p className="text-sm text-muted">No achievements earned yet.</p>;
  }

  return (
    <div className="grid grid-cols-2 gap-px border border-line-sheet bg-line-sheet sm:grid-cols-3 lg:grid-cols-5">
      {groups.map((g) => (
        <div key={g.achievementKey} className="flex flex-col gap-1 bg-sheet px-4 py-3.5" title={g.description}>
          <div className="display text-[10px] tracking-[0.16em] text-muted">{g.label}</div>
          <div className="display text-[22px] font-bold leading-none text-kelly-deep">×{g.count}</div>
          <div className="text-[12px] text-muted">
            Most recent: {g.mostRecent.season} Wk {g.mostRecent.week}
          </div>
        </div>
      ))}
    </div>
  );
}
