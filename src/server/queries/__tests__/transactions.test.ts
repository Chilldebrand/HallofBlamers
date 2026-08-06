import { describe, expect, it } from "vitest";
import { createDb } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { franchises, leagues, players, rosterSlots, seasons, teamSeasons, transactionItems, transactions } from "../../db/schema";
import { getTransactionCenter } from "../transactions";

describe("getTransactionCenter", () => {
  it("returns a public read-only model without commissioner or credential fields", () => {
    const opened = createDb(":memory:");
    runMigrations(opened.db);
    const league = opened.db.insert(leagues).values({ espnLeagueId: 1, name: "Fixture League", firstSeason: 2022 }).returning().get();
    opened.db.insert(seasons).values({ season: 2022, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 2, regSeasonWeeks: 14, status: "complete" }).run();
    const alpha = opened.db.insert(franchises).values({ canonicalName: "Alpha", managerName: "Ann", joinedSeason: 2022 }).returning().get();
    const bravo = opened.db.insert(franchises).values({ canonicalName: "Bravo", managerName: "Bea", joinedSeason: 2022 }).returning().get();
    const teamAlpha = opened.db.insert(teamSeasons).values({ season: 2022, franchiseId: alpha.id, espnTeamId: 1, teamName: "A", wins: 1, losses: 0, ties: 0, pointsFor: 100, pointsAgainst: 90, madePlayoffs: true }).returning().get();
    opened.db.insert(teamSeasons).values({ season: 2022, franchiseId: bravo.id, espnTeamId: 2, teamName: "B", wins: 0, losses: 1, ties: 0, pointsFor: 90, pointsAgainst: 100, madePlayoffs: false }).run();
    opened.db.insert(players).values({ espnPlayerId: 101, fullName: "Literal Pickup", defaultPosition: "RB" }).run();
    const claim = opened.db.insert(transactions).values({ season: 2022, espnTxId: "claim-1", type: "waiver", status: "EXECUTED", bidAmount: 4, rawJson: { scoringPeriodId: 3 } }).returning().get();
    opened.db.insert(transactionItems).values({ transactionId: claim.id, teamSeasonId: teamAlpha.id, playerId: 101, action: "add", source: "espn" }).run();
    opened.db.insert(rosterSlots).values({ season: 2022, week: 3, teamSeasonId: teamAlpha.id, playerId: 101, lineupSlot: "RB", isStarter: true, points: 16, projectedPoints: 12, eligibleSlotsJson: ["RB"] }).run();

    const model = getTransactionCenter(2022, opened.db);
    expect(model.waivers).toHaveLength(1);
    expect(model.waivers[0]).toMatchObject({ franchiseId: alpha.id, franchiseName: "Alpha", playerName: "Literal Pickup", starterPoints: 16, pointsPerFaab: 4 });
    expect(JSON.stringify(model)).not.toMatch(/commissioner|cookie|credential|inviteToken|session/i);
    opened.sqlite.close();
  });

  it("returns stable empty collections when no local transaction history exists", () => {
    const opened = createDb(":memory:");
    runMigrations(opened.db);
    expect(getTransactionCenter("career", opened.db)).toEqual({ scope: "career", seasons: [], waivers: [], trades: [], notices: [] });
    opened.sqlite.close();
  });
});
