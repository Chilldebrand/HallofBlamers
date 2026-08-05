"use client";

import { useEffect, useRef } from "react";
import { parseLiveEventFrame } from "./parseEvent";
import { LIVE_EVENT_TYPES, type LiveEventFrame } from "./types";

/**
 * Thin client wiring around `GET /api/live` (SSE, Task 25) for the live UI (Task 33 wiring wave).
 * Deliberately NOT unit-tested — this repo has no jsdom/EventSource test environment (vitest runs
 * with `environment: "node"`, see vitest.config.ts and FranchiseName.test.tsx's docstring), and
 * real live behavior is untestable until real games anyway (Sept 9 — see the task brief). All the
 * logic worth unit-testing (parsing a frame, deciding what a frame means for a scoreboard cell or
 * a ticker moment) already lives in pure, tested modules (`parseEvent.ts`, `scoreUpdate.ts`,
 * `beltTransferEvent.ts`, `tickerMoment.ts`) that this hook just wires up to a real `EventSource`.
 * Verified instead via the brief's manual method: synthetic events inserted into a scratch DB
 * `events` table while a dev server on port 3031 tails `/api/live`.
 *
 * Contract:
 *   - Opens ONE `EventSource("/api/live")` while `enabled` is true; closes it when `enabled`
 *     becomes false or the component unmounts.
 *   - `Last-Event-ID` resume is automatic browser behavior on the EventSource's OWN reconnect
 *     attempts (a real platform limitation — no custom headers on the FIRST connect — see
 *     `src/app/api/live/route.ts`'s docstring); this hook doesn't need to do anything extra for
 *     that to work.
 *   - After `FALLBACK_ERROR_THRESHOLD` consecutive `onerror` events with no successful message in
 *     between, gives up on SSE entirely and calls `onFallback` ONCE so the caller can switch to
 *     polling `/api/live/snapshot` (the documented fallback contract) — never calls it more than
 *     once per mount, and never re-opens the EventSource after that.
 */
const FALLBACK_ERROR_THRESHOLD = 3;

export interface UseLiveEventsOptions {
  /** False disables the hook entirely (no EventSource opened) — e.g. offseason, or a historical
   * (non-current) week that has nothing live to show. */
  enabled: boolean;
  onEvent: (frame: LiveEventFrame) => void;
  /** Called at most once per mount, when SSE has failed repeatedly — see FALLBACK_ERROR_THRESHOLD. */
  onFallback?: () => void;
}

export function useLiveEvents({ enabled, onEvent, onFallback }: UseLiveEventsOptions): void {
  const onEventRef = useRef(onEvent);
  const onFallbackRef = useRef(onFallback);

  // Refs updated in an effect, never during render (react-hooks/refs) — runs after every commit,
  // still well before the next SSE message could possibly arrive.
  useEffect(() => {
    onEventRef.current = onEvent;
    onFallbackRef.current = onFallback;
  });

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof window.EventSource === "undefined") return;

    const source = new EventSource("/api/live");
    let consecutiveErrors = 0;
    let fellBack = false;

    const handleMessage = (evt: MessageEvent<string>) => {
      consecutiveErrors = 0;
      const frame = parseLiveEventFrame(evt.data);
      if (frame) onEventRef.current(frame);
    };

    for (const eventType of LIVE_EVENT_TYPES) {
      source.addEventListener(eventType, handleMessage);
    }

    source.onerror = () => {
      consecutiveErrors++;
      if (!fellBack && consecutiveErrors >= FALLBACK_ERROR_THRESHOLD) {
        fellBack = true;
        source.close();
        onFallbackRef.current?.();
      }
    };

    return () => {
      for (const eventType of LIVE_EVENT_TYPES) {
        source.removeEventListener(eventType, handleMessage);
      }
      source.close();
    };
  }, [enabled]);
}
