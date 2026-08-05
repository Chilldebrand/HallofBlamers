"use client";

import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

export interface TickerProps {
  items: ReactNode[];
  /** Seconds for one full loop of the (doubled) track. */
  speedSeconds?: number;
  className?: string;
}

/**
 * Horizontal marquee strip. Pauses on hover and disables entirely under
 * prefers-reduced-motion (see `.ticker-track` in globals.css). Renders
 * nothing when `items` is empty rather than showing an empty bar.
 *
 * Owns only the scroll mechanics — the outer container and each item's
 * presentation are fully up to the caller (see
 * components/layout/SeasonTicker.tsx for the shell's season-aware LIVE /
 * OFFSEASON usage, docs/design/redesign-2026-08/README.md's Shell spec).
 */
export function Ticker({ items, speedSeconds = 28, className }: TickerProps) {
  if (items.length === 0) return null;

  // Duplicated so a translateX(-50%) loop is seamless.
  const track = [...items, ...items];

  return (
    <div className={cn("group relative overflow-hidden", className)}>
      <div
        className="ticker-track flex w-max items-center gap-10 whitespace-nowrap py-2 group-hover:[animation-play-state:paused]"
        style={{ animationDuration: `${speedSeconds}s` }}
      >
        {track.map((item, index) => (
          <span key={index} className="inline-flex items-center">
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}
