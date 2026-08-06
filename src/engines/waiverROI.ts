import { computePossessionWindows, type AcquireEvent, type DepartEvent, type PossessionWindow, type RosterPointRow } from "./rosterPossession";

export interface WaiverAcquisitionEvent {
  teamSeasonId: number;
  franchiseId: number;
  playerId: number;
  week: number;
  type: "waiver" | "freeagent";
  bidAmount: number | null;
  transactionId: number;
  espnTxId: string;
}

export interface WaiverDepartureEvent {
  teamSeasonId: number;
  playerId: number;
  week: number;
}

export interface WaiverAcquisitionResult {
  teamSeasonId: number;
  franchiseId: number;
  playerId: number;
  type: "waiver" | "freeagent";
  bidAmount: number | null;
  transactionId: number;
  espnTxId: string;
  acquiredWeek: number;
  droppedWeek: number | null;
  stillRostered: boolean;
  weeksRostered: number;
  startsMade: number;
  starterPoints: number;
  pointsPerStart: number | null;
  pointsPerFaab: number | null;
}

export function computeWaiverAcquisitions(
  acquisitions: WaiverAcquisitionEvent[],
  departures: WaiverDepartureEvent[],
  rosterRows: RosterPointRow[],
): WaiverAcquisitionResult[] {
  const franchiseByTeamSeason = new Map<number, number>();
  const events: (AcquireEvent | DepartEvent)[] = [];

  for (const a of acquisitions) {
    franchiseByTeamSeason.set(a.teamSeasonId, a.franchiseId);
    events.push({
      kind: "acquire",
      teamSeasonId: a.teamSeasonId,
      playerId: a.playerId,
      week: a.week,
      acquisitionType: a.type,
      transactionId: a.transactionId,
      espnTxId: a.espnTxId,
    });
  }
  for (const d of departures) {
    events.push({ kind: "depart", teamSeasonId: d.teamSeasonId, playerId: d.playerId, week: d.week });
  }

  const windows = computePossessionWindows(events, rosterRows);
  const bidByTransaction = new Map(acquisitions.map((a) => [a.transactionId, a.bidAmount]));

  return windows
    .filter((w): w is PossessionWindow & { acquisitionType: "waiver" | "freeagent" } => w.acquisitionType === "waiver" || w.acquisitionType === "freeagent")
    .map((w) => ({
      teamSeasonId: w.teamSeasonId,
      franchiseId: franchiseByTeamSeason.get(w.teamSeasonId)!,
      playerId: w.playerId,
      type: w.acquisitionType,
      bidAmount: bidByTransaction.get(w.transactionId) ?? null,
      transactionId: w.transactionId,
      espnTxId: w.espnTxId,
      acquiredWeek: w.startWeek,
      droppedWeek: w.endWeekExclusive,
      stillRostered: w.stillRostered,
      weeksRostered: w.weeksRostered,
      startsMade: w.startsMade,
      starterPoints: w.starterPoints,
      pointsPerStart: w.startsMade > 0 ? w.starterPoints / w.startsMade : null,
      pointsPerFaab:
        w.acquisitionType === "waiver" && (bidByTransaction.get(w.transactionId) ?? 0) > 0
          ? w.starterPoints / (bidByTransaction.get(w.transactionId) ?? 1)
          : null,
    }));
}

export const computeWaiverRoi = computeWaiverAcquisitions;
