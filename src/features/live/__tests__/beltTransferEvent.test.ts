import { describe, expect, it } from "vitest";
import { extractBeltTransfer } from "../beltTransferEvent";
import type { LiveEventFrame } from "../types";

function frame(overrides: Partial<LiveEventFrame> = {}): LiveEventFrame {
  return {
    id: 1,
    eventType: "BeltTransferred",
    season: 2026,
    week: 3,
    occurredAt: 1700000000000,
    franchiseId: 7,
    matchupId: 9,
    playerId: null,
    payload: { holderFranchiseName: "Old Holder", holderScore: 90.1, challengerFranchiseName: "New Holder", challengerScore: 100.2 },
    ...overrides,
  };
}

describe("extractBeltTransfer", () => {
  it("builds overlay data for a BeltTransferred event on a displayed matchup", () => {
    const data = extractBeltTransfer(frame(), new Set([9]));
    expect(data).toEqual({ newHolderName: "New Holder", previousHolderName: "Old Holder", newHolderScore: 100.2, previousHolderScore: 90.1 });
  });

  it("returns null for any other event type (e.g. BeltDefended never triggers the overlay)", () => {
    expect(extractBeltTransfer(frame({ eventType: "BeltDefended" }), new Set([9]))).toBeNull();
  });

  it("returns null when the matchup isn't currently displayed — MVP scoping, no site-wide interrupt", () => {
    expect(extractBeltTransfer(frame(), new Set([1, 2, 3]))).toBeNull();
  });

  it("returns null when matchupId is missing", () => {
    expect(extractBeltTransfer(frame({ matchupId: null }), new Set([9]))).toBeNull();
  });

  it("returns null when the payload has no challenger name to render", () => {
    expect(extractBeltTransfer(frame({ payload: { holderFranchiseName: "Old Holder" } }), new Set([9]))).toBeNull();
  });

  it("degrades gracefully when the payload is missing holderFranchiseName (defensive — not a real emit-events.ts shape today)", () => {
    const data = extractBeltTransfer(frame({ payload: { challengerFranchiseName: "New Holder" } }), new Set([9]));
    expect(data).toEqual({ newHolderName: "New Holder", previousHolderName: null, newHolderScore: null, previousHolderScore: null });
  });
});
