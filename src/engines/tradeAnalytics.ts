import { computePossessionWindows, type AcquireEvent, type DepartEvent, type PossessionWindow, type RosterPointRow } from "./rosterPossession";

export type TradeItemSource = "espn" | "inferred";

export interface TradeReceivedItem {
  transactionId: number;
  espnTxId: string;
  season: number;
  week: number;
  teamSeasonId: number;
  franchiseId: number;
  playerId: number;
  source: TradeItemSource;
}

export interface TradeDepartureEvent {
  teamSeasonId: number;
  playerId: number;
  week: number;
}

export interface TradeReceivedPlayerResult {
  playerId: number;
  weeksRostered: number;
  startsMade: number;
  starterPoints: number;
  pointsPerStart: number | null;
  stillRostered: boolean;
  droppedWeek: number | null;
  source: TradeItemSource;
}

export interface TradeSideResult {
  franchiseId: number;
  teamSeasonId: number;
  received: TradeReceivedPlayerResult[];
  totalStarterPoints: number;
}

export interface TradeLedgerEntry {
  transactionId: number;
  espnTxId: string;
  season: number;
  tradeWeek: number;
  sides: TradeSideResult[];
  winnerFranchiseId: number | null;
  marginPoints: number | null;
  dataQuality: "espn_confirmed" | "recovered_incomplete";
}

export function computeTradeLedger(received: TradeReceivedItem[], departures: TradeDepartureEvent[], rosterRows: RosterPointRow[]): TradeLedgerEntry[] {
  const byTransaction = new Map<number, TradeReceivedItem[]>();
  for (const item of received) {
    const list = byTransaction.get(item.transactionId);
    if (list) list.push(item);
    else byTransaction.set(item.transactionId, [item]);
  }

  const events: (AcquireEvent | DepartEvent)[] = [
    ...received.map(
      (item): AcquireEvent => ({
        kind: "acquire",
        teamSeasonId: item.teamSeasonId,
        playerId: item.playerId,
        week: item.week,
        acquisitionType: "trade",
        transactionId: item.transactionId,
        espnTxId: item.espnTxId,
      }),
    ),
    ...departures.map((d): DepartEvent => ({ kind: "depart", teamSeasonId: d.teamSeasonId, playerId: d.playerId, week: d.week })),
  ];
  const windows = computePossessionWindows(events, rosterRows);

  const windowByKey = new Map<string, PossessionWindow>();
  for (const w of windows) {
    if (w.acquisitionType !== "trade") continue;
    windowByKey.set(`${w.transactionId}:${w.teamSeasonId}:${w.playerId}`, w);
  }

  const entries: TradeLedgerEntry[] = [];

  for (const [transactionId, items] of byTransaction) {
    const first = items[0]!;

    const bySide = new Map<number, TradeReceivedItem[]>();
    for (const item of items) {
      const list = bySide.get(item.teamSeasonId);
      if (list) list.push(item);
      else bySide.set(item.teamSeasonId, [item]);
    }

    const sides: TradeSideResult[] = [...bySide.values()].map((sideItems) => {
      const teamSeasonId = sideItems[0]!.teamSeasonId;
      const franchiseId = sideItems[0]!.franchiseId;
      const receivedResults = sideItems.map((item): TradeReceivedPlayerResult => {
        const w = windowByKey.get(`${transactionId}:${teamSeasonId}:${item.playerId}`);
        if (!w) return { playerId: item.playerId, weeksRostered: 0, startsMade: 0, starterPoints: 0, pointsPerStart: null, stillRostered: false, droppedWeek: null, source: item.source };
        return {
          playerId: item.playerId,
          weeksRostered: w.weeksRostered,
          startsMade: w.startsMade,
          starterPoints: w.starterPoints,
          pointsPerStart: w.startsMade > 0 ? w.starterPoints / w.startsMade : null,
          stillRostered: w.stillRostered,
          droppedWeek: w.endWeekExclusive,
          source: item.source,
        };
      }).sort((a, b) => a.playerId - b.playerId);
      return {
        franchiseId,
        teamSeasonId,
        received: receivedResults,
        totalStarterPoints: receivedResults.reduce((sum, r) => sum + r.starterPoints, 0),
      };
    }).sort((a, b) => a.franchiseId - b.franchiseId || a.teamSeasonId - b.teamSeasonId);

    let winnerFranchiseId: number | null = null;
    let marginPoints: number | null = null;
    if (sides.length === 2) {
      const [sideA, sideB] = sides as [TradeSideResult, TradeSideResult];
      const diff = sideA.totalStarterPoints - sideB.totalStarterPoints;
      marginPoints = Math.abs(diff);
      winnerFranchiseId = diff === 0 ? null : diff > 0 ? sideA.franchiseId : sideB.franchiseId;
    }

    entries.push({
      transactionId,
      espnTxId: first.espnTxId,
      season: first.season,
      tradeWeek: first.week,
      sides,
      winnerFranchiseId,
      marginPoints,
      dataQuality: items.some((item) => item.source === "inferred") ? "recovered_incomplete" : "espn_confirmed",
    });
  }

  return entries.sort((a, b) => a.season - b.season || a.tradeWeek - b.tradeWeek || a.transactionId - b.transactionId);
}

export const analyzeTrade = computeTradeLedger;
