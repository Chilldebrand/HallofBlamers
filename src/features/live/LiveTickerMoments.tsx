"use client";

import { useState } from "react";
import { Ticker } from "@/components/broadcast/Ticker";
import { cn } from "@/components/ui/cn";
import { formatTickerMoment, type TickerMoment } from "./tickerMoment";
import { useLiveEvents } from "./useLiveEvents";

/**
 * "Just In" moments ticker (Task 33 brief item 1c) — consumes live events (lead changes, finals,
 * records, beatdowns) additively, alongside the shell's existing games/facts ticker
 * (`src/components/layout/SeasonTicker.tsx`, unchanged). Renders NOTHING when there's nothing to
 * show (the common case — most page loads have no just-happened live moment), which is also this
 * component's entire JS-disabled baseline: with no JS, `useLiveEvents` never subscribes, so this
 * always renders null. That's the honest fallback for a moments feed that has no meaning without
 * a live connection — there's no server-computed "moments so far" to server-render as a baseline.
 */
const MAX_MOMENTS = 5;

export function LiveTickerMoments({ enabled }: { enabled: boolean }) {
  const [moments, setMoments] = useState<TickerMoment[]>([]);

  useLiveEvents({
    enabled,
    onEvent: (frame) => {
      const moment = formatTickerMoment(frame);
      if (!moment) return;
      setMoments((prev) => {
        if (prev.some((m) => m.key === moment.key)) return prev; // dedupe a re-delivered frame (e.g. after an SSE resume)
        return [moment, ...prev].slice(0, MAX_MOMENTS);
      });
    },
    // No fallback wiring here deliberately — /api/live/snapshot has no "moments" data to poll for
    // (it's current scores only, see mergeSnapshotCells's docstring), so once SSE has repeatedly
    // failed this strip simply stops growing rather than fabricating a polling substitute.
  });

  if (moments.length === 0) return null;

  return (
    <div className="flex items-stretch border-b border-line bg-chrome-deep">
      <div className="display flex shrink-0 items-center border-r border-line px-4 py-1.5 text-[11px] tracking-[0.2em] text-kelly-bright">Just In</div>
      <Ticker
        items={moments.map((m) => (
          <span key={m.key} className={cn("text-sm", m.tone === "gold" ? "text-gold-ink" : "text-ink-on-chrome")}>
            {m.text}
          </span>
        ))}
        speedSeconds={22}
        className="flex-1"
      />
    </div>
  );
}
