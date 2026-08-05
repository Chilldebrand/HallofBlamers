import { describe, expect, it } from "vitest";
import { formatTickerMoment } from "../tickerMoment";
import type { LiveEventFrame } from "../types";

function frame(eventType: string, payload: unknown): LiveEventFrame {
  return { id: 5, eventType, season: 2026, week: 3, occurredAt: 1700000000000, franchiseId: null, matchupId: 9, playerId: null, payload };
}

describe("formatTickerMoment", () => {
  it("MatchupLeadChanged: names the new leader with the current score", () => {
    const m = formatTickerMoment(frame("MatchupLeadChanged", { leader: "home", homeFranchiseName: "Gridiron Gladiators", homeScore: 55.5, awayFranchiseName: "Bench Warmers", awayScore: 44.4 }));
    expect(m).toEqual({ key: "live-5", text: "Gridiron Gladiators takes the lead — 55.5–44.4", tone: "kelly" });
  });

  it("MatchupLeadChanged: a tie leader produces no moment (nothing to announce)", () => {
    expect(formatTickerMoment(frame("MatchupLeadChanged", { leader: "tie" }))).toBeNull();
  });

  it("MatchupFinished: names the winner", () => {
    const m = formatTickerMoment(
      frame("MatchupFinished", { homeFranchiseName: "Gridiron Gladiators", homeScore: 110.1, awayFranchiseName: "Bench Warmers", awayScore: 90.2, winner: "home" }),
    );
    expect(m).toEqual({ key: "live-5", text: "FINAL: Gridiron Gladiators wins, 110.1–90.2", tone: "kelly" });
  });

  it("MatchupFinished: a tie result gets its own honest wording, no fabricated winner", () => {
    const m = formatTickerMoment(
      frame("MatchupFinished", { homeFranchiseName: "Gridiron Gladiators", homeScore: 100, awayFranchiseName: "Bench Warmers", awayScore: 100, winner: "tie" }),
    );
    expect(m?.text).toBe("FINAL: Gridiron Gladiators 100.0 – Bench Warmers 100.0 (tie)");
  });

  it("BeltDefended: gold tone", () => {
    const m = formatTickerMoment(frame("BeltDefended", { holderFranchiseName: "Champs", holderScore: 120, challengerScore: 100 }));
    expect(m).toEqual({ key: "live-5", text: "Champs defends the belt, 120.0–100.0", tone: "gold" });
  });

  it("BeltTransferred: gold tone, names both sides", () => {
    const m = formatTickerMoment(frame("BeltTransferred", { holderFranchiseName: "Old Champs", challengerFranchiseName: "New Champs" }));
    expect(m).toEqual({ key: "live-5", text: "New Champs takes the belt from Old Champs", tone: "gold" });
  });

  it("RecordBroken: verb varies by kind (sets/ties/breaks)", () => {
    expect(formatTickerMoment(frame("RecordBroken", { franchiseName: "F1", recordLabel: "Highest Week Score", kind: "sets" }))?.text).toBe(
      "F1 sets the record for Highest Week Score",
    );
    expect(formatTickerMoment(frame("RecordBroken", { franchiseName: "F1", recordLabel: "Highest Week Score", kind: "ties" }))?.text).toBe(
      "F1 ties the record for Highest Week Score",
    );
    expect(formatTickerMoment(frame("RecordBroken", { franchiseName: "F1", recordLabel: "Highest Week Score", kind: "breaks" }))?.text).toBe(
      "F1 breaks the record for Highest Week Score",
    );
  });

  it("BeatdownOfWeek: absolute margin, never a signed negative", () => {
    const m = formatTickerMoment(frame("BeatdownOfWeek", { franchiseName: "F1", margin: -38.4 }));
    expect(m?.text).toBe("Beatdown of the Week: F1 by 38.4");
  });

  it("returns null for a lineup-hole event (admin-panel only, never the ticker)", () => {
    expect(formatTickerMoment(frame("LineupHoleDetected", {}))).toBeNull();
  });

  it("returns null when a required name field is missing (never renders a blank moment)", () => {
    expect(formatTickerMoment(frame("BeatdownOfWeek", { margin: -10 }))).toBeNull();
  });
});
