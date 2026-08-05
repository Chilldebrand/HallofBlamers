/**
 * Per-season validation gates, run BEFORE the normalizer writes anything for
 * that season (see AGENTS.md + Task 5 brief). A failure here means the whole
 * season is skipped — errors are collected and returned, never thrown, so
 * `normalizeAll` can keep going for other seasons.
 */
import { unwrapLeagueHistoryPayload, type EspnSeasonScopePayload } from "./espn-shapes";
import { asFiniteNumber } from "./parse-utils";

export interface SeasonValidationResult {
  valid: boolean;
  errors: string[];
  /** Present whenever the payload at least parsed as JSON, even if later gates failed. */
  json?: EspnSeasonScopePayload;
}

const MIN_TEAMS = 4;
const MAX_TEAMS = 24;
const MIN_SCORE = 0;
/** Exclusive upper bound. */
const MAX_SCORE = 400;
const MIN_SCORING_PERIOD = 1;
const MAX_SCORING_PERIOD = 25;

function describeMatchup(entry: { id?: unknown; matchupPeriodId?: unknown }): string {
  return `schedule entry id=${String(entry.id ?? "?")} (period ${String(entry.matchupPeriodId ?? "?")})`;
}

/**
 * Validates a season-scope snapshot payload against the brief's gates:
 * parses; `settings`/`status`/`teams` present; team count in [4, 24] and
 * matches `settings.size` when that field is present; every matchup score is
 * null/absent or in [0, 400); every schedule entry's `matchupPeriodId` is in
 * [1, 25]; every schedule entry's team ids exist in `teams`.
 *
 * `season`, when given, is only used to pick the right entry out of a
 * `leagueHistory`-style array-wrapped payload (real pre-2018 seasons — see
 * `unwrapLeagueHistoryPayload`); it isn't itself validated against anything
 * in the payload.
 */
export function validateSeasonScopePayload(payloadText: string, season?: number): SeasonValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch (err) {
    return {
      valid: false,
      errors: [`season-scope payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const json = unwrapLeagueHistoryPayload(parsed, season);

  if (json === undefined) {
    return { valid: false, errors: ["season-scope payload was an empty array"] };
  }
  if (json === null || typeof json !== "object") {
    return { valid: false, errors: ["season-scope payload root is not a JSON object"] };
  }

  const obj = json as EspnSeasonScopePayload;
  const errors: string[] = [];

  if (!obj.settings || typeof obj.settings !== "object") errors.push("missing `settings`");
  if (!obj.status || typeof obj.status !== "object") errors.push("missing `status`");
  if (!Array.isArray(obj.teams)) errors.push("missing/invalid `teams` array");

  const teams = Array.isArray(obj.teams) ? obj.teams : [];
  const teamIds = new Set(teams.map((t) => asFiniteNumber(t?.id)).filter((id): id is number => id !== undefined));

  if (Array.isArray(obj.teams)) {
    const teamCount = obj.teams.length;
    if (teamCount < MIN_TEAMS || teamCount > MAX_TEAMS) {
      errors.push(`team count ${teamCount} is outside the allowed range [${MIN_TEAMS}, ${MAX_TEAMS}]`);
    }
    const settingsSize = asFiniteNumber(obj.settings?.size);
    if (settingsSize !== undefined && settingsSize !== teamCount) {
      errors.push(`team count ${teamCount} does not match settings.size (${settingsSize})`);
    }
  }

  const schedule = Array.isArray(obj.schedule) ? obj.schedule : [];
  for (const entry of schedule) {
    for (const side of [entry.home, entry.away]) {
      if (!side) continue;
      const raw = side.totalPoints;
      if (raw === undefined || raw === null) continue; // null/absent is allowed
      const points = asFiniteNumber(raw);
      if (points === undefined || points < MIN_SCORE || points >= MAX_SCORE) {
        errors.push(`${describeMatchup(entry)}: score ${JSON.stringify(raw)} is out of range [${MIN_SCORE}, ${MAX_SCORE})`);
      }
    }

    const period = asFiniteNumber(entry.matchupPeriodId);
    if (period === undefined || period < MIN_SCORING_PERIOD || period > MAX_SCORING_PERIOD) {
      errors.push(
        `${describeMatchup(entry)}: matchupPeriodId ${JSON.stringify(entry.matchupPeriodId)} is out of range ` +
          `[${MIN_SCORING_PERIOD}, ${MAX_SCORING_PERIOD}]`,
      );
    }

    const homeTeamId = asFiniteNumber(entry.home?.teamId);
    if (homeTeamId !== undefined && !teamIds.has(homeTeamId)) {
      errors.push(`${describeMatchup(entry)}: home teamId ${homeTeamId} not found in \`teams\``);
    }
    if (entry.away) {
      const awayTeamId = asFiniteNumber(entry.away.teamId);
      if (awayTeamId !== undefined && !teamIds.has(awayTeamId)) {
        errors.push(`${describeMatchup(entry)}: away teamId ${awayTeamId} not found in \`teams\``);
      }
    }
  }

  return { valid: errors.length === 0, errors, json: obj };
}
