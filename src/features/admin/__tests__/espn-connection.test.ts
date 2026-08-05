import { describe, expect, it } from "vitest";
import { EspnAuthError, EspnHttpError } from "@/server/espn/client";
import { testEspnConnection, type EspnConnectionTestClient } from "../espn-connection";

const COOKIES = { espn_s2: "s2-value", swid: "{ABCDEF12-3456-7890-ABCD-EF1234567890}" };

describe("testEspnConnection — mocked client, never touches the real network", () => {
  it("success: extracts the league name from settings.name", async () => {
    const client: EspnConnectionTestClient = {
      fetchLeague: async () => ({ json: { settings: { name: "Hall of Blamers" } } }),
    };
    const result = await testEspnConnection({ leagueId: 1690915927, season: 2026, cookies: COOKIES, client });
    expect(result).toEqual({ ok: true, leagueName: "Hall of Blamers" });
  });

  it("success but no league name present: leagueName is null, not a fabricated placeholder", async () => {
    const client: EspnConnectionTestClient = {
      fetchLeague: async () => ({ json: { settings: {} } }),
    };
    const result = await testEspnConnection({ leagueId: 1690915927, season: 2026, cookies: COOKIES, client });
    expect(result).toEqual({ ok: true, leagueName: null });
  });

  it("success with a malformed/unexpected json shape still returns ok with a null league name (never throws)", async () => {
    const client: EspnConnectionTestClient = {
      fetchLeague: async () => ({ json: null }),
    };
    const result = await testEspnConnection({ leagueId: 1690915927, season: 2026, cookies: COOKIES, client });
    expect(result).toEqual({ ok: true, leagueName: null });
  });

  it("auth failure: EspnAuthError maps to reason 'auth' with a helpful message, never echoing cookie values", async () => {
    const client: EspnConnectionTestClient = {
      fetchLeague: async () => {
        throw new EspnAuthError(401, "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/1690915927");
      },
    };
    const result = await testEspnConnection({ leagueId: 1690915927, season: 2026, cookies: COOKIES, client });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("auth");
      expect(result.message).not.toContain(COOKIES.espn_s2);
      expect(result.message).not.toContain(COOKIES.swid);
      expect(result.message.toLowerCase()).toContain("braces");
    }
  });

  it("other failure (e.g. network/5xx): maps to reason 'other', message never echoes cookie values", async () => {
    const client: EspnConnectionTestClient = {
      fetchLeague: async () => {
        throw new EspnHttpError(500, "https://example.com", "ESPN request failed with status 500");
      },
    };
    const result = await testEspnConnection({ leagueId: 1690915927, season: 2026, cookies: COOKIES, client });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("other");
      expect(result.message).not.toContain(COOKIES.espn_s2);
      expect(result.message).not.toContain(COOKIES.swid);
    }
  });

  it("a non-Error throw still produces a safe generic message", async () => {
    const client: EspnConnectionTestClient = {
      fetchLeague: async () => {
        throw "a string, not an Error";
      },
    };
    const result = await testEspnConnection({ leagueId: 1690915927, season: 2026, cookies: COOKIES, client });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("other");
  });
});
