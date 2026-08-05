import type { BeltTransferOverlayData } from "@/components/league/BeltTransferOverlay";
import type { LiveEventFrame } from "./types";

interface BeltTransferredPayloadShape {
  holderFranchiseName?: unknown;
  holderScore?: unknown;
  challengerFranchiseName?: unknown;
  challengerScore?: unknown;
}

/**
 * `BeltTransferred` only (see `emit-events.ts`'s `computeBeltCandidates`): `challenger` is the
 * winner (new holder), `holder` is who they took it from. Only fires the overlay for a matchup
 * currently on-screen (`displayedMatchupIds`) — the MVP's "belt-transfer = a skippable overlay
 * moment ON THE LIVE CARD" scoping, not a global site-wide interrupt. Returns `null` for any other
 * event type, an off-screen matchup, or a payload missing the one field the overlay can't render
 * without (the new holder's name) — never a fabricated overlay.
 */
export function extractBeltTransfer(frame: LiveEventFrame, displayedMatchupIds: ReadonlySet<number>): BeltTransferOverlayData | null {
  if (frame.eventType !== "BeltTransferred") return null;
  if (typeof frame.matchupId !== "number" || !displayedMatchupIds.has(frame.matchupId)) return null;

  const payload = (frame.payload ?? {}) as BeltTransferredPayloadShape;
  if (typeof payload.challengerFranchiseName !== "string") return null;

  return {
    newHolderName: payload.challengerFranchiseName,
    previousHolderName: typeof payload.holderFranchiseName === "string" ? payload.holderFranchiseName : null,
    newHolderScore: typeof payload.challengerScore === "number" ? payload.challengerScore : null,
    previousHolderScore: typeof payload.holderScore === "number" ? payload.holderScore : null,
  };
}
