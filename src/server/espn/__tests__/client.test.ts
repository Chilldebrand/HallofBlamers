import { describe, expect, it, vi } from "vitest";
import { EspnClient } from "../client";
import { EspnAuthError, EspnHttpError, EspnParseError } from "../types";
import type { FetchLike } from "../types";

/** Builds a fetch mock backed by a queue of canned responses, in call order. */
function queuedFetch(responses: Array<() => Response>): { fetchImpl: FetchLike; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let i = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const make = responses[i];
    i++;
    if (!make) throw new Error(`queuedFetch: no response queued for call #${i}`);
    return make();
  }) as unknown as FetchLike;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function textResponse(body: string, status = 200, headers?: Record<string, string>): Response {
  return new Response(body, { status, headers });
}

function noopSleep(): { sleepImpl: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  const sleepImpl = vi.fn(async (ms: number) => {
    delays.push(ms);
  });
  return { sleepImpl, delays };
}

describe("EspnClient.fetchLeague — endpoint selection", () => {
  it("uses the modern endpoint for season >= 2018", async () => {
    const { fetchImpl, calls } = queuedFetch([() => jsonResponse({ id: 123, name: "Modern League" })]);
    const client = new EspnClient({ leagueId: 123, fetchImpl });

    const result = await client.fetchLeague({ season: 2024, views: ["mTeam"] });

    expect(calls[0]!.url).toContain(
      "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2024/segments/0/leagues/123",
    );
    expect(result.json).toEqual({ id: 123, name: "Modern League" });
    expect(result.status).toBe(200);
    expect(result.url).toBe(calls[0]!.url);
  });

  it("uses the history endpoint for season < 2018 and unwraps the array in json while payload keeps raw array text", async () => {
    const leagueObj = { id: 123, name: "History League" };
    const { fetchImpl, calls } = queuedFetch([() => jsonResponse([leagueObj])]);
    const client = new EspnClient({ leagueId: 123, fetchImpl });

    const result = await client.fetchLeague({ season: 2015, views: ["mTeam"] });

    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe(
      "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/leagueHistory/123",
    );
    expect(url.searchParams.get("seasonId")).toBe("2015");
    expect(result.json).toEqual(leagueObj);
    expect(result.payload).toBe(JSON.stringify([leagueObj]));
    expect(JSON.parse(result.payload)).toEqual([leagueObj]);
  });

  it("throws EspnParseError (not a silent undefined json) when the history endpoint returns an empty array", async () => {
    const { fetchImpl } = queuedFetch([() => jsonResponse([])]);
    const client = new EspnClient({ leagueId: 123, fetchImpl });

    await expect(client.fetchLeague({ season: 2015, views: ["mTeam"] })).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(EspnParseError);
      const parseErr = err as EspnParseError;
      expect(parseErr.message).toMatch(/no league object/i);
      expect(parseErr.message).toMatch(/empty array/i);
      return true;
    });
  });
});

describe("EspnClient.fetchLeague — query params", () => {
  it("serializes repeated view params and scoringPeriodId", async () => {
    const { fetchImpl, calls } = queuedFetch([() => jsonResponse({ ok: true })]);
    const client = new EspnClient({ leagueId: 999, fetchImpl });

    await client.fetchLeague({
      season: 2024,
      views: ["mTeam", "mMatchupScore", "mRoster"],
      scoringPeriodId: 7,
    });

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.getAll("view")).toEqual(["mTeam", "mMatchupScore", "mRoster"]);
    expect(url.searchParams.get("scoringPeriodId")).toBe("7");
  });

  it("omits scoringPeriodId when not provided", async () => {
    const { fetchImpl, calls } = queuedFetch([() => jsonResponse({ ok: true })]);
    const client = new EspnClient({ leagueId: 999, fetchImpl });

    await client.fetchLeague({ season: 2024, views: ["mTeam"] });

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.has("scoringPeriodId")).toBe(false);
  });
});

describe("EspnClient.fetchLeague — auth headers", () => {
  it("sends the Cookie header exactly when cookies are provided", async () => {
    const { fetchImpl, calls } = queuedFetch([() => jsonResponse({ ok: true })]);
    const client = new EspnClient({
      leagueId: 1,
      cookies: { espn_s2: "s2-token", swid: "{ABC-123}" },
      fetchImpl,
    });

    await client.fetchLeague({ season: 2024, views: ["mTeam"] });

    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("Cookie")).toBe("espn_s2=s2-token; SWID={ABC-123}");
  });

  it("omits the Cookie header when no cookies are provided", async () => {
    const { fetchImpl, calls } = queuedFetch([() => jsonResponse({ ok: true })]);
    const client = new EspnClient({ leagueId: 1, fetchImpl });

    await client.fetchLeague({ season: 2024, views: ["mTeam"] });

    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.has("Cookie")).toBe(false);
  });

  it("always sends a browser-like User-Agent and Accept: application/json", async () => {
    const { fetchImpl, calls } = queuedFetch([() => jsonResponse({ ok: true })]);
    const client = new EspnClient({ leagueId: 1, fetchImpl });

    await client.fetchLeague({ season: 2024, views: ["mTeam"] });

    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("User-Agent")).toContain("Mozilla/5.0");
    expect(headers.get("User-Agent")).toContain("Chrome/126.0");
  });

  it("serializes the filter object into x-fantasy-filter when passed", async () => {
    const { fetchImpl, calls } = queuedFetch([() => jsonResponse({ ok: true })]);
    const client = new EspnClient({ leagueId: 1, fetchImpl });
    const filter = { players: { filterStatsForTopScoringPeriodIds: { value: 2 } } };

    await client.fetchLeague({ season: 2024, views: ["kona_player_info"], filter });

    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("x-fantasy-filter")).toBe(JSON.stringify(filter));
  });

  it("omits x-fantasy-filter when no filter is passed", async () => {
    const { fetchImpl, calls } = queuedFetch([() => jsonResponse({ ok: true })]);
    const client = new EspnClient({ leagueId: 1, fetchImpl });

    await client.fetchLeague({ season: 2024, views: ["mTeam"] });

    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.has("x-fantasy-filter")).toBe(false);
  });
});

describe("EspnClient.fetchLeague — 401/403 fallback", () => {
  it("retries once on the alternate endpoint form after a 401 and succeeds", async () => {
    const leagueObj = { id: 5, name: "Fallback League" };
    const { fetchImpl, calls } = queuedFetch([
      () => textResponse("Unauthorized", 401),
      () => jsonResponse(leagueObj),
    ]);
    const client = new EspnClient({ leagueId: 5, fetchImpl });

    const result = await client.fetchLeague({ season: 2024, views: ["mTeam"] });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("/seasons/2024/segments/0/leagues/5");
    expect(calls[1]!.url).toContain("/leagueHistory/5");
    expect(result.json).toEqual(leagueObj);
  });

  it("throws EspnAuthError carrying status + url when both endpoint forms return 401", async () => {
    const { fetchImpl, calls } = queuedFetch([
      () => textResponse("Unauthorized", 401),
      () => textResponse("Unauthorized", 401),
    ]);
    const client = new EspnClient({ leagueId: 5, fetchImpl });

    await expect(client.fetchLeague({ season: 2024, views: ["mTeam"] })).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(EspnAuthError);
      const authErr = err as EspnAuthError;
      expect(authErr.status).toBe(401);
      expect(authErr.url).toBe(calls[1]!.url);
      return true;
    });
  });

  it("throws EspnAuthError when both endpoint forms return 403", async () => {
    const { fetchImpl } = queuedFetch([
      () => textResponse("Forbidden", 403),
      () => textResponse("Forbidden", 403),
    ]);
    const client = new EspnClient({ leagueId: 5, fetchImpl });

    await expect(client.fetchLeague({ season: 2010, views: ["mTeam"] })).rejects.toBeInstanceOf(EspnAuthError);
  });
});

describe("EspnClient.fetchLeague — 429/5xx backoff", () => {
  it("succeeds after backoff on 429 then 200, recording the injected sleep delay", async () => {
    const { fetchImpl, calls } = queuedFetch([
      () => textResponse("Too Many Requests", 429),
      () => jsonResponse({ ok: true }),
    ]);
    const { sleepImpl, delays } = noopSleep();
    const client = new EspnClient({ leagueId: 1, fetchImpl, sleepImpl });

    const result = await client.fetchLeague({ season: 2024, views: ["mTeam"] });

    expect(calls).toHaveLength(2);
    expect(result.json).toEqual({ ok: true });
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(0);
    expect(delays[0]).toBeLessThanOrEqual(2000);
  });

  it("honors a Retry-After header (seconds) when present", async () => {
    const { fetchImpl } = queuedFetch([
      () => textResponse("Too Many Requests", 429, { "Retry-After": "5" }),
      () => jsonResponse({ ok: true }),
    ]);
    const { sleepImpl, delays } = noopSleep();
    const client = new EspnClient({ leagueId: 1, fetchImpl, sleepImpl });

    await client.fetchLeague({ season: 2024, views: ["mTeam"] });

    expect(delays[0]).toBe(5000);
  });

  it("exhausts retries on repeated 5xx and throws EspnHttpError", async () => {
    const { fetchImpl, calls } = queuedFetch([
      () => textResponse("err", 500),
      () => textResponse("err", 502),
      () => textResponse("err", 503),
      () => textResponse("err", 500),
    ]);
    const { sleepImpl, delays } = noopSleep();
    const client = new EspnClient({ leagueId: 1, fetchImpl, sleepImpl });

    await expect(client.fetchLeague({ season: 2024, views: ["mTeam"] })).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(EspnHttpError);
      expect(err).not.toBeInstanceOf(EspnAuthError);
      const httpErr = err as EspnHttpError;
      expect(httpErr.status).toBe(500);
      return true;
    });
    expect(calls).toHaveLength(4);
    expect(delays).toHaveLength(3);
  });

  it("does not retry non-401/403/429 4xx responses", async () => {
    const { fetchImpl, calls } = queuedFetch([() => textResponse("Not Found", 404)]);
    const client = new EspnClient({ leagueId: 1, fetchImpl });

    await expect(client.fetchLeague({ season: 2024, views: ["mTeam"] })).rejects.toBeInstanceOf(EspnHttpError);
    expect(calls).toHaveLength(1);
  });
});

describe("EspnClient.fetchLeague — non-JSON body", () => {
  it("throws EspnParseError with the first 200 chars of the body on a non-JSON 200 response", async () => {
    const html = "<html><body>" + "x".repeat(500) + "</body></html>";
    const { fetchImpl } = queuedFetch([() => textResponse(html, 200)]);
    const client = new EspnClient({ leagueId: 1, fetchImpl });

    await expect(client.fetchLeague({ season: 2024, views: ["mTeam"] })).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(EspnParseError);
      const parseErr = err as EspnParseError;
      expect(parseErr.snippet).toBe(html.slice(0, 200));
      expect(parseErr.snippet.length).toBe(200);
      return true;
    });
  });
});
