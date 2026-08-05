import type { LiveEventFrame } from "./types";

/**
 * Formats a live event into the shell's "Just In" moments ticker (Task 33 wiring wave, brief item
 * 1c: "lead changes, finals, records, beatdowns"). Pure text formatting only — every field it
 * reads is already render-ready on the payload (franchise names/numbers included, per
 * `emit-events.ts`'s own docstring), so this never re-derives anything or fetches a name. Returns
 * `null` for an event type this ticker doesn't surface (lineup holes — admin/panel-only) or a
 * payload missing a field the moment can't be worded without honestly.
 */
export interface TickerMoment {
  /** Stable per source event id — React key, and lets a caller dedupe a moment it's already shown. */
  key: string;
  text: string;
  /** "gold" only for belt moments (the one ticker context gold is already used for — see
   * SeasonTicker's existing belt-holder fact item); every other moment is kelly. */
  tone: "gold" | "kelly";
}

function fmt1(value: unknown): string {
  return typeof value === "number" ? value.toFixed(1) : "—";
}

interface MomentPayload {
  leader?: unknown;
  homeFranchiseName?: unknown;
  homeScore?: unknown;
  awayFranchiseName?: unknown;
  awayScore?: unknown;
  winner?: unknown;
  holderFranchiseName?: unknown;
  holderScore?: unknown;
  challengerFranchiseName?: unknown;
  challengerScore?: unknown;
  franchiseName?: unknown;
  recordLabel?: unknown;
  kind?: unknown;
  margin?: unknown;
}

export function formatTickerMoment(frame: LiveEventFrame): TickerMoment | null {
  const p = (frame.payload ?? {}) as MomentPayload;
  const key = `live-${frame.id}`;

  switch (frame.eventType) {
    case "MatchupLeadChanged": {
      // "tie" carries no single leader to announce — not a moment worth a ticker line.
      if (p.leader !== "home" && p.leader !== "away") return null;
      const name = p.leader === "home" ? p.homeFranchiseName : p.awayFranchiseName;
      if (typeof name !== "string") return null;
      return { key, text: `${name} takes the lead — ${fmt1(p.homeScore)}–${fmt1(p.awayScore)}`, tone: "kelly" };
    }
    case "MatchupFinished": {
      if (typeof p.homeFranchiseName !== "string" || typeof p.awayFranchiseName !== "string") return null;
      const winnerName = p.winner === "home" ? p.homeFranchiseName : p.winner === "away" ? p.awayFranchiseName : null;
      const text = winnerName
        ? `FINAL: ${winnerName} wins, ${fmt1(p.homeScore)}–${fmt1(p.awayScore)}`
        : `FINAL: ${p.homeFranchiseName} ${fmt1(p.homeScore)} – ${p.awayFranchiseName} ${fmt1(p.awayScore)} (tie)`;
      return { key, text, tone: "kelly" };
    }
    case "BeltDefended": {
      if (typeof p.holderFranchiseName !== "string") return null;
      return { key, text: `${p.holderFranchiseName} defends the belt, ${fmt1(p.holderScore)}–${fmt1(p.challengerScore)}`, tone: "gold" };
    }
    case "BeltTransferred": {
      if (typeof p.challengerFranchiseName !== "string" || typeof p.holderFranchiseName !== "string") return null;
      return { key, text: `${p.challengerFranchiseName} takes the belt from ${p.holderFranchiseName}`, tone: "gold" };
    }
    case "RecordBroken": {
      if (typeof p.franchiseName !== "string" || typeof p.recordLabel !== "string") return null;
      const verb = p.kind === "sets" ? "sets" : p.kind === "ties" ? "ties" : "breaks";
      return { key, text: `${p.franchiseName} ${verb} the record for ${p.recordLabel}`, tone: "kelly" };
    }
    case "BeatdownOfWeek": {
      if (typeof p.franchiseName !== "string") return null;
      const marginText = typeof p.margin === "number" ? fmt1(Math.abs(p.margin)) : "—";
      return { key, text: `Beatdown of the Week: ${p.franchiseName} by ${marginText}`, tone: "kelly" };
    }
    default:
      return null;
  }
}
