/**
 * The "Test Connection" logic, kept out of actions.ts (every export of a `"use server"` module
 * must itself be an async Server Action) and shaped to take an INJECTABLE client so tests never
 * make a real network call — mirrors src/server/ai/recap.ts's `generateRecap({..., client?})`
 * pattern from Task 13.
 */
import { EspnAuthError, EspnClient } from "@/server/espn/client";
import type { EspnCookies } from "@/server/espn/types";

export interface EspnConnectionTestClient {
  fetchLeague(params: { season: number; views: ["mSettings"] }): Promise<{ json: unknown }>;
}

export type EspnConnectionTestResult =
  | { ok: true; leagueName: string | null }
  | { ok: false; reason: "auth" | "other"; message: string };

/** ESPN's `mSettings` view carries the league's display name at `settings.name` — confirmed
 * against a real archived snapshot before writing this (not guessed from community docs, per the
 * espn-fantasy-data skill's rule). */
function extractLeagueName(json: unknown): string | null {
  const name = (json as { settings?: { name?: unknown } } | null)?.settings?.name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

/**
 * ONE polite live fetch (`mSettings` only — the smallest view that proves the cookies actually
 * authenticate) against the given season. Never touches the database and never logs/returns the
 * cookie values themselves — only a league name (public-ish, not secret) on success, or a
 * generic message on failure. Default client is a real `EspnClient`; tests always inject a mock.
 */
export async function testEspnConnection(params: {
  leagueId: number;
  season: number;
  cookies: EspnCookies;
  client?: EspnConnectionTestClient;
}): Promise<EspnConnectionTestResult> {
  const client = params.client ?? new EspnClient({ leagueId: params.leagueId, cookies: params.cookies });

  try {
    const result = await client.fetchLeague({ season: params.season, views: ["mSettings"] });
    return { ok: true, leagueName: extractLeagueName(result.json) };
  } catch (err) {
    if (err instanceof EspnAuthError) {
      return {
        ok: false,
        reason: "auth",
        message: "ESPN rejected these cookies (authentication failed). Double-check you copied them exactly, including SWID's curly braces.",
      };
    }
    return { ok: false, reason: "other", message: `Could not reach ESPN: ${err instanceof Error ? err.message : "unknown error"}.` };
  }
}
