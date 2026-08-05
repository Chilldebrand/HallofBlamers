"use client";

import { useState } from "react";
import { BeltTransferOverlay, type BeltTransferOverlayData } from "@/components/league/BeltTransferOverlay";

/**
 * /belt's "replayable variant" of the belt-transfer moment (Task 33 brief item 2) — same
 * `BeltTransferOverlay` the live cards trigger from a real SSE event, here triggered on demand
 * from the current reign's already-known static data (no live connection involved at all). Only
 * rendered by the page when the current reign was actually WON from someone (never for a vacancy
 * award — see the page's call site).
 */
export function ReplayBeltTransferButton({ data }: { data: BeltTransferOverlayData }) {
  const [showing, setShowing] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setShowing(true)}
        className="display border border-line-sheet-strong px-4 py-2 text-xs tracking-[0.12em] text-ink hover:border-ink"
      >
        Replay Transfer
      </button>
      {showing ? <BeltTransferOverlay data={data} onDismiss={() => setShowing(false)} /> : null}
    </>
  );
}
