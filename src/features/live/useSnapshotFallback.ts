"use client";

import { useEffect, useRef } from "react";
import type { LiveScoreCell } from "./scoreUpdate";

/**
 * Polling fallback for `/api/live/snapshot` (Task 25's documented fallback contract), used once
 * `useLiveEvents` has given up on SSE (see its `onFallback`). Deliberately NOT unit-tested — same
 * reasoning as `useLiveEvents.ts` (no jsdom/fetch-mocking harness in this repo's test setup); the
 * reconciliation logic it feeds (`mergeSnapshotCells`, `scoreUpdate.ts`) IS unit-tested.
 */
export interface UseSnapshotFallbackOptions {
  /** True once SSE has failed repeatedly — starts polling; false is a no-op (no fetch at all). */
  active: boolean;
  pollMs?: number;
  onRows: (rows: LiveScoreCell[]) => void;
}

interface SnapshotSideShape {
  franchiseId?: unknown;
  score?: unknown;
}
interface SnapshotMatchupShape {
  matchupId?: unknown;
  isFinal?: unknown;
  home?: SnapshotSideShape;
  away?: SnapshotSideShape | null;
}
interface SnapshotResponseShape {
  matchups?: SnapshotMatchupShape[];
}

function toSide(s: SnapshotSideShape | null | undefined): { franchiseId: number; score: number | null } | null {
  if (!s || typeof s.franchiseId !== "number") return null;
  return { franchiseId: s.franchiseId, score: typeof s.score === "number" ? s.score : null };
}

export function useSnapshotFallback({ active, pollMs = 15000, onRows }: UseSnapshotFallbackOptions): void {
  const onRowsRef = useRef(onRows);

  // Ref updated in an effect, never during render (react-hooks/refs).
  useEffect(() => {
    onRowsRef.current = onRows;
  });

  useEffect(() => {
    if (!active) return;

    let cancelled = false;

    async function poll(): Promise<void> {
      try {
        const res = await fetch("/api/live/snapshot", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as SnapshotResponseShape;
        if (cancelled || !Array.isArray(data.matchups)) return;

        const rows: LiveScoreCell[] = [];
        for (const m of data.matchups) {
          if (typeof m.matchupId !== "number") continue;
          const home = toSide(m.home);
          if (!home) continue;
          rows.push({ matchupId: m.matchupId, isFinal: Boolean(m.isFinal), home, away: toSide(m.away) });
        }
        onRowsRef.current(rows);
      } catch {
        // Best-effort poll — a failed fetch just tries again next interval, no error UI.
      }
    }

    void poll();
    const id = setInterval(poll, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, pollMs]);
}
