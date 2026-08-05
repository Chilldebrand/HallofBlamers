import Link from "next/link";
import type { WeekAchievementRow } from "@/server/queries/achievements";

/**
 * Week hub's compact "this week's achievements" strip (Task 33 wiring wave, brief item 3) — only
 * rendered by the caller when `getWeekAchievements` returns at least one row (a settled week with
 * awards; see that query's own docstring for why an unsettled week needs no separate check here).
 * Same ink/kelly-only grammar as `AchievementTrophyCase` — never gold, not a belt context.
 */
export function WeekAchievementsStrip({ achievements }: { achievements: WeekAchievementRow[] }) {
  if (achievements.length === 0) return null;

  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {achievements.map((a, i) => (
        <Link
          key={`${a.achievementKey}-${a.franchiseId}-${i}`}
          href={`/franchises/${a.franchiseId}`}
          className="inline-flex items-center gap-1.5 border border-line-sheet bg-sheet px-2.5 py-1 text-[12px] transition-colors hover:border-ink"
        >
          <span className="display text-[10px] tracking-[0.14em] text-kelly-deep">{a.label}</span>
          <span className="text-ink">{a.franchiseName}</span>
        </Link>
      ))}
    </div>
  );
}
