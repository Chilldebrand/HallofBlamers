import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TradeCard } from "./page";

describe("TradeCard", () => {
  it("renders a machine-readable incomplete state and only canonical franchise links for recovered trades", () => {
    const html = renderToStaticMarkup(
      <TradeCard
        flags={{ championFranchiseId: null, beltHolderFranchiseId: null, sackoFranchiseId: null, viewerFranchiseId: null }}
        trade={{
          transactionId: 7,
          espnTxId: "recovered-7",
          season: 2023,
          tradeWeek: 5,
          winnerFranchiseId: null,
          marginPoints: null,
          dataQuality: "recovered_incomplete",
          sides: [
            { franchiseId: 41, franchiseName: "Alpha", teamSeasonId: 11, totalStarterPoints: 10, received: [{ playerId: 101, playerName: "Player One", weeksRostered: 2, startsMade: 1, starterPoints: 10, pointsPerStart: 10, stillRostered: true, droppedWeek: null, source: "inferred" }] },
            { franchiseId: 42, franchiseName: "Bravo", teamSeasonId: 22, totalStarterPoints: 8, received: [{ playerId: 202, playerName: "Player Two", weeksRostered: 2, startsMade: 1, starterPoints: 8, pointsPerStart: 8, stillRostered: true, droppedWeek: null, source: "inferred" }] },
          ],
        }}
      />,
    );

    expect(html).toContain('data-quality="recovered-incomplete"');
    expect(html).toContain('href="/franchises/41"');
    expect(html).toContain('href="/franchises/42"');
    expect(html).toContain("Participant names and missing pieces are never inferred");
  });
});
