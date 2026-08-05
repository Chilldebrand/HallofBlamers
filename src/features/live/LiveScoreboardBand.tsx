"use client";

import { useState } from "react";
import Link from "next/link";
import { useReducedMotion } from "motion/react";
import { AnimatedNumber } from "@/components/broadcast/AnimatedNumber";
import { BeltTransferOverlay, type BeltTransferOverlayData } from "@/components/league/BeltTransferOverlay";
import { FranchiseName, type FranchiseNameFlags } from "@/components/league/FranchiseName";
import { cn } from "@/components/ui/cn";
import { extractBeltTransfer } from "./beltTransferEvent";
import { applyScoreUpdate, extractScoreUpdate, mergeSnapshotCells } from "./scoreUpdate";
import { useLiveEvents } from "./useLiveEvents";
import { useSnapshotFallback } from "./useSnapshotFallback";

/**
 * Live wiring for the home page's in-season scoreboard band (Task 33 brief item 1a + 2). The SSR
 * baseline (`src/components/home/ScoreboardBand.tsx`'s `InSeasonScoreboardBand`, unchanged) bakes
 * each side's identity flags server-side (never resolved client-side — `resolveFranchiseFlags`
 * lives under `src/server/`, which this client island must never import) and hands the result
 * here as plain initial state; with JS disabled this renders byte-identical markup to before this
 * task, just without the live subscription (progressive enhancement, honest fallback).
 */
export interface LiveScoreboardSide {
  franchiseId: number;
  name: string;
  score: number | null;
  flags: FranchiseNameFlags;
}

export interface LiveScoreboardCellData {
  matchupId: number;
  isBeltGame: boolean;
  isViewerGame: boolean;
  isFinal: boolean;
  home: LiveScoreboardSide;
  away: LiveScoreboardSide | null;
}

export interface LiveScoreboardBandProps {
  season: number;
  week: number;
  cells: LiveScoreboardCellData[];
}

const FLASH_MS = 900;

function cellStatusLabel(cell: { isBeltGame: boolean; isViewerGame: boolean; isFinal: boolean }): string {
  if (cell.isBeltGame) return cell.isViewerGame ? "Belt match · you" : "Belt match";
  const base = cell.isFinal ? "Final" : "In Progress";
  return cell.isViewerGame ? `${base} · you` : base;
}

export function LiveScoreboardBand({ season, week, cells: initialCells }: LiveScoreboardBandProps) {
  const [cells, setCells] = useState(initialCells);
  const [flashIds, setFlashIds] = useState<ReadonlySet<number>>(new Set());
  const [fallback, setFallback] = useState(false);
  const [overlay, setOverlay] = useState<BeltTransferOverlayData | null>(null);
  // Fix round 1, finding 7: the flash was a raw Tailwind class toggle, invisible to
  // `MotionConfig reducedMotion="user"` (that only governs `motion/react`'s OWN animate/transform
  // props, never a plain CSS `transition-shadow` class) — gate it on the same OS signal
  // `AnimatedNumber` already reads, so a reduced-motion viewer gets the score update instantly,
  // with no flash, instead of an un-suppressible pulse.
  const prefersReducedMotion = useReducedMotion();

  useLiveEvents({
    enabled: true,
    onFallback: () => setFallback(true),
    onEvent: (frame) => {
      const scoreUpdate = extractScoreUpdate(frame);
      if (scoreUpdate) {
        setCells((prev) => applyScoreUpdate(prev, scoreUpdate));
        // Brief kelly flash (MVP lead-change treatment, brief item 2) — deliberately outside the
        // setCells updater above so it never fires twice under StrictMode's dev double-invoke.
        setFlashIds((ids) => new Set(ids).add(scoreUpdate.matchupId));
        window.setTimeout(() => {
          setFlashIds((ids) => {
            if (!ids.has(scoreUpdate.matchupId)) return ids;
            const next = new Set(ids);
            next.delete(scoreUpdate.matchupId);
            return next;
          });
        }, FLASH_MS);
        return;
      }

      const displayedMatchupIds = new Set(cells.map((c) => c.matchupId));
      const transfer = extractBeltTransfer(frame, displayedMatchupIds);
      if (transfer) setOverlay(transfer);
    },
  });

  useSnapshotFallback({ active: fallback, onRows: (rows) => setCells((prev) => mergeSnapshotCells(prev, rows)) });

  return (
    <>
      <div className="grid grid-cols-2 border-b border-line bg-chrome md:grid-cols-6">
        {cells.slice(0, 2).map((cell) => (
          <LiveCell
            key={`m-${cell.matchupId}`}
            season={season}
            week={week}
            cell={cell}
            flashing={!prefersReducedMotion && flashIds.has(cell.matchupId)}
            className="md:hidden"
          />
        ))}
        {cells.map((cell) => (
          <LiveCell
            key={`d-${cell.matchupId}`}
            season={season}
            week={week}
            cell={cell}
            flashing={!prefersReducedMotion && flashIds.has(cell.matchupId)}
            className="hidden md:block"
          />
        ))}
      </div>
      {overlay ? <BeltTransferOverlay data={overlay} onDismiss={() => setOverlay(null)} /> : null}
    </>
  );
}

function LiveCell({
  season,
  week,
  cell,
  flashing,
  className,
}: {
  season: number;
  week: number;
  cell: LiveScoreboardCellData;
  flashing: boolean;
  className?: string;
}) {
  const surface = cell.isBeltGame ? "var(--color-chrome-raised)" : "var(--color-chrome)";
  const label = cellStatusLabel(cell);
  const labelColor = cell.isBeltGame ? "text-gold-ink" : cell.isFinal ? "text-muted-on-chrome" : "text-live";

  return (
    <Link
      href={`/matchups/${season}/${week}/${cell.matchupId}`}
      className={cn(
        "border-r border-line-soft px-5 py-3.5 transition-shadow duration-700 last:border-r-0",
        cell.isBeltGame ? "bg-chrome-raised" : undefined,
        // Lead-change flash (brief item 2, MVP-simple) — an inset box-shadow rather than a
        // background-color class: `cn` does no Tailwind conflict resolution (see its own
        // docstring), so a second `bg-*` class here could lose to `bg-chrome-raised` above
        // depending on generated CSS order; box-shadow is a different property entirely, so
        // there's no ordering risk either way.
        flashing ? "shadow-[inset_0_0_0_2px_var(--color-kelly-bright)]" : undefined,
        className,
      )}
    >
      <div className={cn("display mb-2 text-[11px] tracking-[0.18em]", labelColor)}>{label}</div>
      <LiveSideRow side={cell.home} surface={surface} />
      {cell.away ? <LiveSideRow side={cell.away} surface={surface} muted /> : <div className="mt-1 text-[13px] text-muted-on-chrome">Bye</div>}
    </Link>
  );
}

function LiveSideRow({ side, surface, muted }: { side: LiveScoreboardSide; surface: string; muted?: boolean }) {
  return (
    <div className={cn("mt-1 flex items-center justify-between gap-2", muted ? "opacity-80" : undefined)}>
      <FranchiseName
        franchise={{ id: side.franchiseId, name: side.name, ...side.flags }}
        size="row"
        surfaceBehind={surface}
        className="display truncate text-[16px] text-ink-on-chrome"
      />
      {side.score !== null ? (
        <AnimatedNumber value={side.score} decimals={1} className="display shrink-0 text-[19px] text-ink-on-chrome" />
      ) : (
        <span className="display shrink-0 text-[19px] text-ink-on-chrome">—</span>
      )}
    </div>
  );
}
