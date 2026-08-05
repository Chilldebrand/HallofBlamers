import type { ReactNode } from "react";
import { Ticker } from "@/components/broadcast/Ticker";
import { FranchiseName } from "@/components/league/FranchiseName";
import { cn } from "@/components/ui/cn";
import { getDb } from "@/server/db/client";
import { getIdentityFlags, resolveFranchiseFlags, type IdentityFlags } from "@/server/queries/identity";
import { getTickerContent, type TickerItemData } from "@/server/queries/ticker";

export interface SeasonTickerProps {
  /** The signed-in manager's id, or null for a spectator/no-session render path — used only to
   * flag "your game" in-season; the ticker itself never gates on auth. */
  viewerManagerId: number | null;
}

// The ticker's own background — belt marks rendered inside it need this as their cut-out color
// so the gold mark reads as a cut-out against the ticker bar, not the sheet (FranchiseName's
// default assumption).
const TICKER_SURFACE = "var(--color-chrome-deep)";

/**
 * Shell ticker — directly under the nav (README Shell spec). Season-aware: a
 * fixed LIVE (red, pulsing wbb-blink dot) or OFFSEASON (kelly) tab on the
 * left, then the marquee (Ticker.tsx's existing scroll mechanics, reused
 * exactly). In-season shows the current week's games — belt game first,
 * viewer's game flagged; offseason shows league facts (belt holder,
 * champion, draft countdown, a record leader).
 */
export function SeasonTicker({ viewerManagerId }: SeasonTickerProps) {
  const db = getDb();
  const flags = getIdentityFlags(db, viewerManagerId);
  const content = getTickerContent(flags.viewerFranchiseId);
  const isLive = content.phase === "in-season";

  return (
    <div className="flex items-stretch border-b border-line bg-chrome-deep">
      <div
        className={cn(
          "display flex shrink-0 items-center gap-1.5 border-r border-line px-4 py-2 text-[13px] tracking-[0.2em]",
          isLive ? "text-live" : "text-kelly-bright",
        )}
      >
        {isLive ? <span className="wbb-blink inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-live" aria-hidden="true" /> : null}
        {isLive ? "LIVE" : "OFFSEASON"}
      </div>
      {content.items.length > 0 ? <Ticker items={content.items.map((item) => renderTickerItem(item, flags))} className="flex-1" /> : null}
    </div>
  );
}

function renderTickerItem(item: TickerItemData, flags: IdentityFlags): ReactNode {
  if (item.kind === "game") {
    const home = { id: item.homeFranchiseId, name: item.homeName, ...resolveFranchiseFlags(flags, item.homeFranchiseId) };
    const away =
      item.awayFranchiseId !== null ? { id: item.awayFranchiseId, name: item.awayName ?? "—", ...resolveFranchiseFlags(flags, item.awayFranchiseId) } : null;

    return (
      <span key={item.matchupId} className="flex items-center gap-2 text-sm text-ink-on-chrome">
        <FranchiseName franchise={home} size="row" surfaceBehind={TICKER_SURFACE} />
        <span className="tabular-nums text-muted-on-chrome">{item.homeScore ?? "—"}</span>
        <span className="text-muted-on-chrome">–</span>
        {away ? (
          <>
            <FranchiseName franchise={away} size="row" surfaceBehind={TICKER_SURFACE} />
            <span className="tabular-nums text-muted-on-chrome">{item.awayScore ?? "—"}</span>
          </>
        ) : (
          <span className="text-muted-on-chrome">BYE</span>
        )}
        <span className={cn("display text-[10px] tracking-[0.16em]", item.isFinal ? "text-muted-on-chrome" : "text-live")}>
          {item.isFinal ? "FINAL" : "IN PROGRESS"}
        </span>
        {item.isViewerGame ? <span className="display text-[10px] tracking-[0.16em] text-kelly-bright">· Your Game</span> : null}
      </span>
    );
  }

  // Fact item — belt holder / champion (franchiseId+franchiseName set) get the same identity
  // treatment (gold name, belt mark) as the in-season game branch above; facts with no single
  // franchise subject (draft countdown, record leader) render as plain text.
  const franchise = item.franchiseId !== null && item.franchiseName !== null ? { id: item.franchiseId, name: item.franchiseName } : null;

  return (
    <span key={`${item.label}-${item.franchiseId}-${item.detail}`} className="flex items-center gap-2 text-sm text-ink-on-chrome">
      <span className="display text-[10px] tracking-[0.16em] text-muted-on-chrome">{item.label}</span>
      {franchise ? (
        <FranchiseName franchise={{ ...franchise, ...resolveFranchiseFlags(flags, franchise.id) }} size="row" surfaceBehind={TICKER_SURFACE} />
      ) : null}
      {item.detail ? <span className={franchise ? "text-muted-on-chrome" : undefined}>{item.detail}</span> : null}
    </span>
  );
}
