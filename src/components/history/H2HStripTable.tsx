"use client";

import { useState } from "react";
import Link from "next/link";
import { FranchiseName, type FranchiseNameFlags } from "@/components/league/FranchiseName";
import { cn } from "@/components/ui/cn";
import { formatWLT } from "./format";

export interface H2HStripRow {
  opponentId: number;
  opponentName: string;
  wins: number;
  losses: number;
  ties: number;
  games: number;
  avgMargin: number;
  streakText: string | null;
  /** Resolved server-side (README: "the identity flags ... should be resolved server-side and
   * passed to FranchiseName as props — client components must not import from src/server/*"). */
  flags: FranchiseNameFlags;
  /** Real per-game results, oldest -> newest, capped to the most recent 11 (README: "a balance
   * strip of 11px win/loss squares, most recent on the right") — see
   * getFranchiseH2HGameLog, never approximated from the aggregate W/L. */
  recentResults: ("W" | "L" | "T")[];
}

export interface H2HStripTableProps {
  rows: H2HStripRow[];
}

type SortKey = "games" | "opponentName";

const GRID = "grid-cols-[1fr_84px_150px]";

/**
 * Client island: receives fully-serialized rows from the server component, no `src/server/*`
 * import. Task 24 restyle (README, Franchise "Head-to-head"): grid `1fr / 84px / 150px` —
 * opponent (with identity marks), record, balance strip of real per-game win/loss squares.
 */
export function H2HStripTable({ rows }: H2HStripTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("games");

  const sorted = [...rows].sort((a, b) => (sortKey === "games" ? b.games - a.games : a.opponentName.localeCompare(b.opponentName)));

  return (
    <div>
      <div className="mb-1 flex justify-end">
        <button
          type="button"
          onClick={() => setSortKey((k) => (k === "games" ? "opponentName" : "games"))}
          className="display text-[11px] tracking-[0.14em] text-muted underline decoration-dotted underline-offset-4 hover:text-ink"
        >
          Sort: {sortKey === "games" ? "Most Games" : "A–Z"}
        </button>
      </div>

      <div role="table">
        <div role="row" className={cn("grid border-b border-line-sheet-strong pb-2.5", GRID)}>
          <span role="columnheader" className="display text-[11px] tracking-[0.14em] text-muted">
            Opponent
          </span>
          <span role="columnheader" className="display text-right text-[11px] tracking-[0.14em] text-muted">
            Record
          </span>
          <span role="columnheader" className="display text-right text-[11px] tracking-[0.14em] text-muted">
            Balance
          </span>
        </div>

        {sorted.map((row) => (
          <div key={row.opponentId} role="row" className={cn("grid items-center border-b border-line-sheet-soft py-[10px] last:border-b-0", GRID)}>
            <span role="cell" className="min-w-0">
              <Link href={`/franchises/${row.opponentId}`} className="hover:underline">
                <FranchiseName franchise={{ id: row.opponentId, name: row.opponentName, ...row.flags }} size="row" surfaceBehind="var(--color-sheet)" />
              </Link>
            </span>
            <span role="cell" className="text-right text-[14px] font-semibold tabular-nums text-ink">
              {formatWLT(row.wins, row.losses, row.ties)}
            </span>
            <span role="cell" className="flex justify-end gap-[2px]">
              {row.recentResults.map((r, i) => (
                <span
                  key={i}
                  aria-hidden="true"
                  className={cn("h-[11px] w-[11px] shrink-0", r === "W" ? "bg-kelly" : r === "L" ? "bg-loss" : "bg-line-sheet-strong")}
                />
              ))}
            </span>
          </div>
        ))}

        {sorted.length === 0 ? <p className="py-6 text-center text-sm text-muted">No head-to-head history yet.</p> : null}
      </div>

      {sorted.length > 0 ? <p className="mt-3 text-[13px] text-muted">Green = win, red = loss, most recent on the right.</p> : null}
    </div>
  );
}
