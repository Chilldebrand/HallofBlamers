"use client";

import { useState } from "react";
import { useReducedMotion } from "motion/react";
import { BeltTransferOverlay, type BeltTransferOverlayData } from "@/components/league/BeltTransferOverlay";
import { cn } from "@/components/ui/cn";
import { MatchupCard, type MatchupCardTeam } from "@/features/scoreboard/components/MatchupCard";
import { extractBeltTransfer } from "./beltTransferEvent";
import { applyBeltLabelUpdate, applyScoreUpdate, extractBeltOutcome, extractScoreUpdate, mergeSnapshotCells } from "./scoreUpdate";
import { useLiveEvents } from "./useLiveEvents";
import { useSnapshotFallback } from "./useSnapshotFallback";

/**
 * Live wiring for the week hub's matchup card grid (Task 33 brief item 1b + 2). ONLY mounted by
 * the page (`src/app/(league)/matchups/[year]/[week]/page.tsx`) when `showLiveState` is true (the
 * current week of an active season) — every other week keeps rendering plain, static
 * `MatchupCard`s server-side with zero client JS, exactly as before this task. `MatchupCard`
 * itself stays "framework-boundary-agnostic" (its own docstring) — this wrapper only decides
 * WHICH props it gets, never touches its internals.
 */
export interface LiveWeekHubCardData {
  matchupId: number;
  href: string;
  home: MatchupCardTeam;
  away: MatchupCardTeam | null;
  isFinal: boolean;
  startersRemaining: number | null;
  beltAtStake: boolean;
  beltLabel: string;
  emphasis: "belt" | "viewer" | "normal";
  superlativeLabel: string | null;
  note: string | null;
}

const FLASH_MS = 900;

export function LiveWeekHubGrid({ cards: initialCards }: { cards: LiveWeekHubCardData[] }) {
  const [cards, setCards] = useState(initialCards);
  const [flashIds, setFlashIds] = useState<ReadonlySet<number>>(new Set());
  const [fallback, setFallback] = useState(false);
  const [overlay, setOverlay] = useState<BeltTransferOverlayData | null>(null);
  // Fix round 1, finding 7 — see LiveScoreboardBand.tsx's identical comment: the flash is a plain
  // CSS class toggle, invisible to `MotionConfig reducedMotion="user"`, so it's gated here instead.
  const prefersReducedMotion = useReducedMotion();

  useLiveEvents({
    enabled: true,
    onFallback: () => setFallback(true),
    onEvent: (frame) => {
      const scoreUpdate = extractScoreUpdate(frame);
      if (scoreUpdate) {
        setCards((prev) => {
          const next = applyScoreUpdate(prev, scoreUpdate);
          if (!scoreUpdate.isFinal) return next;
          // Fix round 1, finding 6: a belt game's `beltLabel` is baked into its initial SSR props
          // ("Belt at stake...") and is never otherwise recomputed — without this, a belt game
          // that goes final via this live score update would keep showing pre-game wording
          // forever. Neutralize to plain "Final" the INSTANT it's final; a same/next-tick
          // BeltDefended/BeltTransferred event (handled below) upgrades it to the real outcome
          // the moment it arrives, so there's only ever a brief "Final" flash, never stale text.
          return next.map((c) => (c.matchupId === scoreUpdate.matchupId && c.beltAtStake && c.beltLabel !== "Final" ? { ...c, beltLabel: "Final" } : c));
        });
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

      const beltOutcome = extractBeltOutcome(frame);
      if (beltOutcome) {
        setCards((prev) => applyBeltLabelUpdate(prev, beltOutcome));
        return;
      }

      const displayedMatchupIds = new Set(cards.map((c) => c.matchupId));
      const transfer = extractBeltTransfer(frame, displayedMatchupIds);
      if (transfer) setOverlay(transfer);
    },
  });

  useSnapshotFallback({ active: fallback, onRows: (rows) => setCards((prev) => mergeSnapshotCells(prev, rows)) });

  return (
    <div className="mt-8 grid gap-5 sm:grid-cols-2">
      {cards.map((card) => (
        <MatchupCard
          key={card.matchupId}
          href={card.href}
          home={card.home}
          away={card.away}
          status={card.isFinal ? { kind: "final" } : { kind: "live", startersRemaining: card.startersRemaining }}
          beltAtStake={card.beltAtStake}
          beltLabel={card.beltLabel}
          emphasis={card.emphasis}
          superlativeLabel={card.superlativeLabel}
          note={card.note}
          className={cn(
            "transition-shadow duration-700",
            // Same box-shadow-not-background-color reasoning as LiveScoreboardBand's flash — see
            // that component's comment.
            !prefersReducedMotion && flashIds.has(card.matchupId) ? "shadow-[inset_0_0_0_2px_var(--color-kelly-bright)]" : undefined,
          )}
        />
      ))}
      {overlay ? <BeltTransferOverlay data={overlay} onDismiss={() => setOverlay(null)} /> : null}
    </div>
  );
}
