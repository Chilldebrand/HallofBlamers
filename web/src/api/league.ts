import type { IdentityFlags } from "../../../src/shared/identity";
import type { SyncStatus, Viewer } from "../../../src/contracts/cloud";
import type { StandingsSource } from "./standings";
import { supabase } from "../lib/supabase";

export interface LeagueShell {
  viewer: Viewer;
  managerName: string;
  franchiseName: string | null;
  flags: IdentityFlags;
  sync: SyncStatus;
}
export type StandingsResponse = StandingsSource & { shell: LeagueShell };

// Only database row keys need translation; shell and envelope fields already
// use the public contract. Never recursively transform user-authored JSON.
export function decodeStandings(payload: unknown): StandingsResponse {
  if (!payload || typeof payload !== "object") throw new Error("Invalid standings response");
  const data = payload as Record<string, unknown>;
  const rows = ["seasons", "franchises", "teamSeasons", "seasonStats", "careerStats", "weeks", "weekResults"];
  const result = { ...data };
  for (const name of rows) {
    if (!Array.isArray(data[name])) throw new Error("Invalid standings response");
    result[name] = data[name].map((row: unknown) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Invalid standings row");
      return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value]));
    });
  }
  if (!Array.isArray(data.seasonOptions) || !data.shell) throw new Error("Invalid standings response");
  return result as unknown as StandingsResponse;
}

export async function fetchStandings(signal: AbortSignal): Promise<StandingsResponse> {
  if (!supabase) throw new Error("League connection unavailable");
  const { data, error } = await supabase.rpc("hob_standings_source", { requested_season: null }).abortSignal(signal);
  if (error) throw new Error("Unable to load standings. Please try again.");
  return decodeStandings(data);
}
