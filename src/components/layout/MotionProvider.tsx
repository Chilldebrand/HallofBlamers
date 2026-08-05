"use client";

import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";

/**
 * Wraps the app in a single MotionConfig so every `motion/react` animation
 * (AnimatedNumber, etc.) automatically honors the user's OS-level
 * prefers-reduced-motion setting, without each component re-checking it.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
