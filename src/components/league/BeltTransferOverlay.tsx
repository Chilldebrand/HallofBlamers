"use client";

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";

/** Data the overlay needs — deliberately just display strings/numbers, decoupled from both the
 * live-event payload shape and `getCurrentReignDetail`'s server shape, so this one component can
 * be fed by either a live SSE frame (`src/features/live/beltTransferEvent.ts`'s
 * `extractBeltTransfer`) or /belt's static "replay" button, from the same interface. */
export interface BeltTransferOverlayData {
  newHolderName: string;
  previousHolderName: string | null;
  newHolderScore: number | null;
  previousHolderScore: number | null;
}

/**
 * The MVP's "simple" belt-transfer moment (Task 33 brief item 2: "a skippable overlay moment...
 * SIMPLE per the MVP's own scoping — no cinematic"). One fade/scale-in, auto-dismisses after
 * `AUTO_DISMISS_MS`, and is always skippable (a Skip button + clicking the backdrop) — root
 * `MotionConfig reducedMotion="user"` (src/components/layout/MotionProvider.tsx) already makes
 * `motion/react` honor the OS reduced-motion setting for the fade/scale animation with no extra
 * code here. The auto-dismiss TIMER itself deliberately does NOT check reduced-motion (fix round
 * 1, finding 1) — dismissing isn't an animation preference, it's "don't block the live UI
 * forever"; reduced-motion only ever governs whether the transition is animated, never whether it
 * happens at all.
 *
 * Deliberately dumb: takes already-resolved display data and an `onDismiss` callback, nothing
 * else — used two ways: (1) the live card wiring (`src/features/live/LiveScoreboardBand.tsx` /
 * `LiveWeekHubGrid.tsx`) triggers it from a real `BeltTransferred` SSE event; (2) `/belt`'s
 * "Replay Transfer" button (`src/features/live/ReplayBeltTransferButton.tsx`) triggers the exact
 * same component from the current reign's already-known static data — same visual moment,
 * replayable on demand, per the brief's "replayable variant on /belt".
 */
const AUTO_DISMISS_MS = 6000;

export function BeltTransferOverlay({ data, onDismiss }: { data: BeltTransferOverlayData; onDismiss: () => void }) {
  // Fix round 1, finding 1: the timer was declared (AUTO_DISMISS_MS) but never actually wired to
  // anything — nothing dismissed the overlay without a click, so it covered the live UI forever.
  // `onDismissRef` (same ref-updated-in-an-effect pattern as `useLiveEvents.ts`) means the timer
  // effect below can depend on `data` alone (restart only when a NEW transfer is shown) without
  // restarting every time the parent re-renders for an unrelated reason (e.g. a live score tick)
  // and hands down a freshly-created inline `onDismiss` closure.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });

  useEffect(() => {
    const timer = window.setTimeout(() => onDismissRef.current(), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [data]);

  return (
    <AnimatePresence>
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Belt transfer"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.25 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4"
        onClick={onDismiss}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.25 }}
          className="max-w-sm border border-line-sheet-strong border-l-[3px] border-l-gold-fill bg-sheet-raised p-6 text-center shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="display text-[12px] tracking-[0.2em] text-gold-ink">Belt Changes Hands</p>
          <p className="display mt-2 text-[24px] text-ink">{data.newHolderName}</p>
          {data.previousHolderName ? <p className="mt-1 text-[15px] text-muted">takes it from {data.previousHolderName}</p> : null}
          {data.newHolderScore !== null && data.previousHolderScore !== null ? (
            <p className="mt-2 tabular-nums text-sm text-ink">
              {data.newHolderScore.toFixed(1)} – {data.previousHolderScore.toFixed(1)}
            </p>
          ) : null}
          <button
            type="button"
            onClick={onDismiss}
            className="display mt-4 border border-line-sheet-strong px-4 py-2 text-xs tracking-[0.12em] text-ink hover:border-ink"
          >
            Skip
          </button>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

export { AUTO_DISMISS_MS as BELT_TRANSFER_OVERLAY_AUTO_DISMISS_MS };
