import { describe, expect, it } from "vitest";
import { LINEUP_SLOT_MAP, LINEUP_SLOT_NAME_TO_ID, POSITION_MAP, PRO_TEAM_MAP } from "../constants";

describe("constants — LINEUP_SLOT_MAP flex slot", () => {
  it("labels lineupSlotId 23 as FLEX (not the source's literal 'RB/WR/TE' string)", () => {
    expect(LINEUP_SLOT_MAP[23]).toBe("FLEX");
  });

  it("resolves LINEUP_SLOT_NAME_TO_ID.FLEX back to 23, matching what downstream code looks up", () => {
    expect(LINEUP_SLOT_NAME_TO_ID.FLEX).toBe(23);
    expect(LINEUP_SLOT_NAME_TO_ID["RB/WR/TE"]).toBeUndefined();
  });

  it("still labels the other brief-called-out slots per the transcribed source values", () => {
    expect(LINEUP_SLOT_MAP[0]).toBe("QB");
    expect(LINEUP_SLOT_MAP[2]).toBe("RB");
    expect(LINEUP_SLOT_MAP[7]).toBe("OP");
    expect(LINEUP_SLOT_MAP[16]).toBe("D/ST");
    expect(LINEUP_SLOT_MAP[17]).toBe("K");
    expect(LINEUP_SLOT_MAP[20]).toBe("BE");
    expect(LINEUP_SLOT_MAP[21]).toBe("IR");
  });
});

describe("constants — POSITION_MAP and PRO_TEAM_MAP minimums", () => {
  it("covers the brief's minimum defaultPositionId entries", () => {
    expect(POSITION_MAP).toMatchObject({ 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" });
  });

  it("covers the brief's minimum proTeamId entries, including 0 = FA/None", () => {
    expect(PRO_TEAM_MAP[0]).toBe("None");
    expect(Object.keys(PRO_TEAM_MAP).length).toBeGreaterThanOrEqual(33);
  });
});
