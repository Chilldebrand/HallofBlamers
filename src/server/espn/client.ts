/**
 * Thin, typed HTTP client for the ESPN Fantasy v3 API.
 *
 * This is the ONLY module in the codebase that knows ESPN's endpoints, auth,
 * and quirks. It does no database access and no snapshot storage — callers
 * (Task 4's snapshot store) archive `payload` verbatim before doing anything
 * else with it. See AGENTS.md.
 */
import {
  EspnAuthError,
  EspnHttpError,
  EspnParseError,
  type EspnClientOptions,
  type EspnCookies,
  type EspnLogger,
  type FetchLeagueParams,
  type FetchLeagueResult,
  type FetchLike,
} from "./types";

export {
  EspnAuthError,
  EspnError,
  EspnHttpError,
  EspnParseError,
  type EspnClientOptions,
  type EspnCookies,
  type EspnLogger,
  type FetchLeagueParams,
  type FetchLeagueResult,
  type FetchLike,
} from "./types";

const MODERN_SEASON_CUTOFF = 2018;
const BASE_URL = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 2000;
const BACKOFF_FACTOR = 2;
const MAX_DELAY_MS = 30_000;

type EndpointKind = "modern" | "history";

const noopLogger: EspnLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Builds the request URL for a given endpoint form, with repeated `view` params. */
function buildUrl(
  kind: EndpointKind,
  leagueId: number,
  season: number,
  views: readonly string[],
  scoringPeriodId: number | undefined,
): string {
  const params = new URLSearchParams();
  if (kind === "history") {
    params.set("seasonId", String(season));
  }
  for (const view of views) {
    params.append("view", view);
  }
  if (scoringPeriodId !== undefined) {
    params.set("scoringPeriodId", String(scoringPeriodId));
  }

  const path =
    kind === "modern"
      ? `${BASE_URL}/seasons/${season}/segments/0/leagues/${leagueId}`
      : `${BASE_URL}/leagueHistory/${leagueId}`;

  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Full-jitter exponential backoff, honoring Retry-After (seconds) when present. */
function computeBackoffDelay(retryIndex: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_DELAY_MS);
    }
  }
  const cap = Math.min(BASE_DELAY_MS * BACKOFF_FACTOR ** retryIndex, MAX_DELAY_MS);
  return Math.random() * cap;
}

function buildCookieHeader(cookies: EspnCookies): string {
  return `espn_s2=${cookies.espn_s2}; SWID=${cookies.swid}`;
}

export class EspnClient {
  private readonly leagueId: number;
  private readonly cookies: EspnCookies | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly logger: EspnLogger;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EspnClientOptions) {
    this.leagueId = options.leagueId;
    this.cookies = options.cookies;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger ?? noopLogger;
    this.sleep = options.sleepImpl ?? defaultSleep;
  }

  /**
   * Fetches a league payload. Selects the modern endpoint for season >= 2018
   * and the history endpoint otherwise; on a 401/403 from the chosen form,
   * retries ONCE on the other form before giving up with EspnAuthError.
   */
  async fetchLeague(params: FetchLeagueParams): Promise<FetchLeagueResult> {
    const primaryKind: EndpointKind = params.season >= MODERN_SEASON_CUTOFF ? "modern" : "history";
    const secondaryKind: EndpointKind = primaryKind === "modern" ? "history" : "modern";

    try {
      return await this.attemptEndpoint(primaryKind, params);
    } catch (err) {
      if (err instanceof EspnAuthError) {
        this.logger.warn(
          { leagueId: this.leagueId, season: params.season, triedKind: primaryKind, status: err.status },
          "ESPN auth failure on primary endpoint form; retrying once on the alternate form",
        );
        return await this.attemptEndpoint(secondaryKind, params);
      }
      throw err;
    }
  }

  /** Runs one endpoint form to completion, including its own 429/5xx backoff loop. */
  private async attemptEndpoint(kind: EndpointKind, params: FetchLeagueParams): Promise<FetchLeagueResult> {
    const url = buildUrl(kind, this.leagueId, params.season, params.views, params.scoringPeriodId);
    let attempt = 0;

    for (;;) {
      attempt++;
      const res = await this.performFetch(url, params.filter);

      if (res.status === 401 || res.status === 403) {
        throw new EspnAuthError(res.status, url);
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt >= MAX_ATTEMPTS) {
          this.logger.error(
            { url, status: res.status, attempt },
            "ESPN request exhausted retries",
          );
          throw new EspnHttpError(
            res.status,
            url,
            `ESPN request failed after ${attempt} attempts with status ${res.status}: ${url}`,
          );
        }
        const delay = computeBackoffDelay(attempt - 1, res.headers.get("retry-after"));
        this.logger.warn(
          { url, status: res.status, attempt, delayMs: delay },
          "ESPN request retrying after backoff",
        );
        await this.sleep(delay);
        continue;
      }

      if (!res.ok) {
        throw new EspnHttpError(res.status, url, `ESPN request failed with status ${res.status}: ${url}`);
      }

      const bodyText = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        throw new EspnParseError(url, bodyText.slice(0, 200));
      }

      let json = parsed;
      if (kind === "history" && Array.isArray(parsed)) {
        if (parsed.length === 0) {
          const snippet = bodyText.slice(0, 200);
          throw new EspnParseError(
            url,
            snippet,
            `ESPN history response contained no league object (empty array) for ${url}: ${snippet}`,
          );
        }
        json = parsed[0];
      }

      return { payload: bodyText, json, url, status: res.status };
    }
  }

  private performFetch(url: string, filter: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    };
    if (this.cookies) {
      headers.Cookie = buildCookieHeader(this.cookies);
    }
    if (filter !== undefined) {
      headers["x-fantasy-filter"] = JSON.stringify(filter);
    }
    return this.fetchImpl(url, { headers });
  }
}
