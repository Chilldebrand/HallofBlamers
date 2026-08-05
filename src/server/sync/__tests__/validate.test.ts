import { describe, expect, it } from "vitest";
import { validateSeasonScopePayload } from "../validate";

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    settings: { name: "Test League", size: 4 },
    status: { finalScoringPeriod: 2 },
    teams: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    schedule: [
      { id: 1, matchupPeriodId: 1, home: { teamId: 1, totalPoints: 100 }, away: { teamId: 2, totalPoints: 90 }, winner: "HOME" },
      { id: 2, matchupPeriodId: 1, home: { teamId: 3, totalPoints: 80 }, away: { teamId: 4, totalPoints: 70 }, winner: "HOME" },
    ],
    ...overrides,
  };
}

describe("validateSeasonScopePayload", () => {
  it("passes a well-formed payload", () => {
    const result = validateSeasonScopePayload(JSON.stringify(validPayload()));
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.json).toBeDefined();
  });

  it("fails on invalid JSON", () => {
    const result = validateSeasonScopePayload("{not json");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/not valid JSON/);
  });

  it("fails when settings/status/teams are all missing", () => {
    const result = validateSeasonScopePayload(JSON.stringify({}));
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("settings"),
        expect.stringContaining("status"),
        expect.stringContaining("teams"),
      ]),
    );
  });

  it("rejects a team count below the allowed range", () => {
    const result = validateSeasonScopePayload(JSON.stringify(validPayload({ teams: [{ id: 1 }, { id: 2 }] })));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("team count 2"))).toBe(true);
  });

  it("rejects a team count above the allowed range", () => {
    const teams = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));
    const result = validateSeasonScopePayload(JSON.stringify(validPayload({ teams })));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("team count 25"))).toBe(true);
  });

  it("rejects when settings.size disagrees with teams.length", () => {
    const result = validateSeasonScopePayload(
      JSON.stringify(validPayload({ settings: { name: "x", size: 10 } })),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("settings.size"))).toBe(true);
  });

  it("does not require settings.size to be present", () => {
    const result = validateSeasonScopePayload(JSON.stringify(validPayload({ settings: { name: "x" } })));
    expect(result.valid).toBe(true);
  });

  it("rejects an out-of-range matchup score (999)", () => {
    const payload = validPayload();
    (payload.schedule as { home: { totalPoints: number } }[])[0]!.home.totalPoints = 999;
    const result = validateSeasonScopePayload(JSON.stringify(payload));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("999") && e.includes("out of range"))).toBe(true);
  });

  it("allows a null/absent score (unplayed matchup)", () => {
    const payload = validPayload();
    (payload.schedule as { home: { totalPoints: number | null } }[])[0]!.home.totalPoints = null as unknown as number;
    const result = validateSeasonScopePayload(JSON.stringify(payload));
    expect(result.valid).toBe(true);
  });

  it("rejects a negative score", () => {
    const payload = validPayload();
    (payload.schedule as { home: { totalPoints: number } }[])[0]!.home.totalPoints = -5;
    const result = validateSeasonScopePayload(JSON.stringify(payload));
    expect(result.valid).toBe(false);
  });

  it("rejects an out-of-range matchupPeriodId", () => {
    const payload = validPayload({
      schedule: [{ id: 1, matchupPeriodId: 99, home: { teamId: 1, totalPoints: 10 }, away: { teamId: 2, totalPoints: 10 } }],
    });
    const result = validateSeasonScopePayload(JSON.stringify(payload));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("matchupPeriodId"))).toBe(true);
  });

  it("rejects a schedule entry referencing a team id not present in `teams`", () => {
    const payload = validPayload({
      schedule: [{ id: 1, matchupPeriodId: 1, home: { teamId: 1, totalPoints: 10 }, away: { teamId: 999, totalPoints: 10 } }],
    });
    const result = validateSeasonScopePayload(JSON.stringify(payload));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("away teamId 999"))).toBe(true);
  });

  it("allows a bye (no away side) without complaint", () => {
    const payload = validPayload({
      schedule: [{ id: 1, matchupPeriodId: 1, home: { teamId: 1, totalPoints: 10 } }],
    });
    const result = validateSeasonScopePayload(JSON.stringify(payload));
    expect(result.valid).toBe(true);
  });
});
