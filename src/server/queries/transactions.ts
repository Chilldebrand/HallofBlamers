import { analyzeTrade, type TradeLedgerEntry, type TradeReceivedItem } from "@/engines/tradeAnalytics";
import type { RosterPointRow } from "@/engines/rosterPossession";
import { computeWaiverRoi, type WaiverAcquisitionEvent, type WaiverAcquisitionResult } from "@/engines/waiverROI";
import { getDb, type Db } from "../db/client";
import { franchises, players, rosterSlots, seasons, teamSeasons, transactionItems, transactions } from "../db/schema";

export type TransactionCenterScope = number | "career";

export interface TransactionCenterWaiver extends WaiverAcquisitionResult {
  season: number;
  franchiseName: string;
  playerName: string;
}

export type TransactionCenterTradeSide = Omit<TradeLedgerEntry["sides"][number], "received"> & {
  franchiseName: string;
  received: Array<TradeLedgerEntry["sides"][number]["received"][number] & { playerName: string }>;
};

export interface TransactionCenterTrade extends Omit<TradeLedgerEntry, "sides"> {
  sides: TransactionCenterTradeSide[];
}

export interface TransactionCenterModel {
  scope: TransactionCenterScope;
  seasons: number[];
  waivers: TransactionCenterWaiver[];
  trades: TransactionCenterTrade[];
  notices: string[];
}

function transactionWeek(rawJson: unknown): number | null {
  if (!rawJson || typeof rawJson !== "object") return null;
  const raw = (rawJson as { scoringPeriodId?: unknown }).scoringPeriodId;
  const week = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isInteger(week) && week > 0 ? week : null;
}

export function getTransactionCenter(scope: TransactionCenterScope = "career", db: Db = getDb()): TransactionCenterModel {
  const seasonRows = db.select({ season: seasons.season }).from(seasons).all();
  const availableSeasons = seasonRows.map((row) => row.season).sort((a, b) => b - a);
  const inScope = (season: number) => scope === "career" || season === scope;

  const txRows = db.select().from(transactions).all().filter((row) => inScope(row.season));
  const txById = new Map(txRows.map((row) => [row.id, row]));
  const itemRows = db.select().from(transactionItems).all().filter((row) => txById.has(row.transactionId));
  const teamRows = db.select().from(teamSeasons).all().filter((row) => inScope(row.season));
  const teamById = new Map(teamRows.map((row) => [row.id, row]));
  const franchiseRows = db.select({ id: franchises.id, name: franchises.canonicalName }).from(franchises).all();
  const franchiseNameById = new Map(franchiseRows.map((row) => [row.id, row.name]));
  const playerRows = db.select({ id: players.espnPlayerId, name: players.fullName }).from(players).all();
  const playerNameById = new Map(playerRows.map((row) => [row.id, row.name]));
  const rosterRows: RosterPointRow[] = db
    .select({ teamSeasonId: rosterSlots.teamSeasonId, playerId: rosterSlots.playerId, week: rosterSlots.week, isStarter: rosterSlots.isStarter, points: rosterSlots.points })
    .from(rosterSlots)
    .all()
    .filter((row) => teamById.has(row.teamSeasonId));

  const notices: string[] = [];
  const missingWeekIds = new Set<number>();
  const acquisitions: WaiverAcquisitionEvent[] = [];
  const departures: Array<{ teamSeasonId: number; playerId: number; week: number }> = [];
  const received: TradeReceivedItem[] = [];

  for (const item of itemRows) {
    const transaction = txById.get(item.transactionId);
    const team = teamById.get(item.teamSeasonId);
    if (!transaction || !team) continue;
    const week = transactionWeek(transaction.rawJson);
    if (week === null) {
      missingWeekIds.add(transaction.id);
      continue;
    }

    if ((item.action === "drop" || item.action === "trade_away") && !departures.some((departure) => departure.teamSeasonId === item.teamSeasonId && departure.playerId === item.playerId && departure.week === week)) {
      departures.push({ teamSeasonId: item.teamSeasonId, playerId: item.playerId, week });
    }
    if (item.action === "add" && (transaction.type === "waiver" || transaction.type === "freeagent")) {
      acquisitions.push({
        teamSeasonId: item.teamSeasonId,
        franchiseId: team.franchiseId,
        playerId: item.playerId,
        week,
        type: transaction.type,
        bidAmount: transaction.bidAmount,
        transactionId: transaction.id,
        espnTxId: transaction.espnTxId,
      });
    }
    if (item.action === "trade_for" && transaction.type === "trade") {
      received.push({
        transactionId: transaction.id,
        espnTxId: transaction.espnTxId,
        season: transaction.season,
        week,
        teamSeasonId: item.teamSeasonId,
        franchiseId: team.franchiseId,
        playerId: item.playerId,
        source: item.source,
      });
    }
  }

  if (missingWeekIds.size > 0) {
    notices.push(`${missingWeekIds.size} transaction${missingWeekIds.size === 1 ? "" : "s"} omitted because the local ESPN record has no scoring period.`);
  }

  const seasonByTeamId = new Map(teamRows.map((row) => [row.id, row.season]));
  const waivers = computeWaiverRoi(acquisitions, departures, rosterRows)
    .map((row): TransactionCenterWaiver => ({
      ...row,
      season: seasonByTeamId.get(row.teamSeasonId) ?? 0,
      franchiseName: franchiseNameById.get(row.franchiseId) ?? `Franchise ${row.franchiseId}`,
      playerName: playerNameById.get(row.playerId) ?? `Player ${row.playerId}`,
    }))
    .sort((a, b) => b.starterPoints - a.starterPoints || b.season - a.season || a.transactionId - b.transactionId);

  const trades = analyzeTrade(received, departures, rosterRows).map((entry): TransactionCenterTrade => ({
    ...entry,
    sides: entry.sides.map((side) => ({
      ...side,
      franchiseName: franchiseNameById.get(side.franchiseId) ?? `Franchise ${side.franchiseId}`,
      received: side.received.map((player) => ({ ...player, playerName: playerNameById.get(player.playerId) ?? `Player ${player.playerId}` })),
    })),
  }));

  if (trades.some((trade) => trade.dataQuality === "recovered_incomplete")) {
    notices.push("Recovered trades are reconstructed from local roster changes and may not include every part of the original deal.");
  }

  return { scope, seasons: availableSeasons, waivers, trades, notices };
}
