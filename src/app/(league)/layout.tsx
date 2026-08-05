import type { ReactNode } from "react";
import { BottomTabBar } from "@/components/layout/BottomTabBar";
import { SeasonTicker } from "@/components/layout/SeasonTicker";
import { TopNav } from "@/components/layout/TopNav";
import { LiveTickerMoments } from "@/features/live/LiveTickerMoments";
import { getDb } from "@/server/db/client";
import { requireManager } from "@/server/auth/guard";
import { getViewerDisplay } from "@/server/queries/identity";
import { getSeasonOptions } from "@/server/queries/standings";
import { computeSeasonPhase } from "@/server/queries/ticker";

/**
 * Authenticated shell: chrome top nav + season-aware ticker (desktop) /
 * sticky bottom tab bar (phone), wrapping a cream content sheet — see
 * docs/design/redesign-2026-08/README.md's "Shell" section. `requireManager()`
 * does a real, DB-backed check on every request; since it awaits
 * next/headers' cookies(), it's also what makes every page under (league)
 * dynamic SSR rather than statically prerendered at build time (AGENTS.md:
 * "every page is dynamic SSR, no ISR").
 *
 * NOT a substitute for a per-route/per-action check, though: this only runs
 * on a fresh render of the layout (first load, or a full page navigation).
 * Next.js does NOT re-invoke a shared layout's server code on client-side
 * "soft" navigation between sibling routes under it — so if a session were
 * revoked mid-visit, clicking to another (league) page wouldn't necessarily
 * re-run this check first. Any commissioner-only page or Server Action MUST
 * therefore call requireCommissioner() itself (see src/features/admin/actions.ts
 * for the first real example) — never rely on this layout, or on
 * render-time-only gating in general, as the authoritative check.
 */
export default async function LeagueLayout({ children }: { children: ReactNode }) {
  const manager = await requireManager();
  const viewer = getViewerDisplay(getDb(), manager);
  const phase = computeSeasonPhase(getSeasonOptions());

  return (
    <div className="flex min-h-screen flex-col bg-frame">
      <TopNav isCommissioner={manager.role === "commissioner"} managerName={viewer.managerName} franchiseName={viewer.franchiseName} />
      <SeasonTicker viewerManagerId={manager.id} />
      {/* Task 33 wiring wave, brief item 1c — additive "Just In" live-moments strip, only ever
          subscribes in-season (computeSeasonPhase is the same season-state signal every other
          season-aware surface uses, per ScoreboardBand.tsx/ticker.ts's own convention). Renders
          nothing until a live moment actually arrives — see its own docstring. */}
      <LiveTickerMoments enabled={phase === "in-season"} />
      <main className="mx-auto w-full max-w-5xl flex-1 bg-sheet px-5 pb-8 pt-5 sm:px-6 md:px-11 md:pb-13 md:pt-[34px]">{children}</main>
      <BottomTabBar />
    </div>
  );
}
