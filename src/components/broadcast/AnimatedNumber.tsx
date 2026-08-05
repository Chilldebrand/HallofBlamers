"use client";

import { useEffect, useRef, useState } from "react";
import { animate, useReducedMotion } from "motion/react";
import { cn } from "@/components/ui/cn";

export interface AnimatedNumberProps {
  value: number;
  /** Decimal places to render, e.g. 1 for points, 0 for a win count. */
  decimals?: number;
  /** Tween duration in seconds. */
  duration?: number;
  className?: string;
}

/**
 * Counts up/down from the previous value to the new one whenever `value`
 * changes. Under prefers-reduced-motion (via MotionProvider's MotionConfig)
 * it skips the tween and renders the final value instantly.
 */
export function AnimatedNumber({ value, decimals = 0, duration = 0.6, className }: AnimatedNumberProps) {
  const prefersReducedMotion = useReducedMotion();
  const [display, setDisplay] = useState(value);
  const previousValue = useRef(value);

  useEffect(() => {
    if (prefersReducedMotion) {
      // Nothing to animate — `shown` below renders `value` directly. Just
      // keep the ref in sync so a later un-reduced change tweens from here.
      previousValue.current = value;
      return;
    }

    const controls = animate(previousValue.current, value, {
      duration,
      ease: "easeOut",
      onUpdate: (latest) => setDisplay(latest),
    });
    previousValue.current = value;

    return () => controls.stop();
  }, [value, prefersReducedMotion, duration]);

  const shown = prefersReducedMotion ? value : display;

  return <span className={cn("tabular-nums", className)}>{shown.toFixed(decimals)}</span>;
}
