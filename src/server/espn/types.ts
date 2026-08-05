/**
 * Request/response types for the ESPN Fantasy v3 client.
 *
 * Kept thin on purpose: we type only what the client itself consumes
 * (params in, envelope out). Full ESPN payload shapes are NOT modeled here —
 * fetched payloads are archived verbatim as raw JSON (see AGENTS.md, Task 4)
 * and parsed into typed structures later by the normalizer, not here.
 */

/** Known ESPN fantasy football `view` query values this codebase uses. */
export const ESPN_VIEWS = [
  "mTeam",
  "mMatchup",
  "mMatchupScore",
  "mRoster",
  "mBoxscore",
  "mSettings",
  "mDraftDetail",
  "mStandings",
  "mTransactions2",
  "mLiveScoring",
  "kona_player_info",
] as const;

export type EspnView = (typeof ESPN_VIEWS)[number];

/** Private-league auth cookies. `swid` must include its surrounding braces, e.g. `{ABC-123}`. */
export interface EspnCookies {
  espn_s2: string;
  swid: string;
}

/** A fetch-like function matching the global `fetch` signature — injectable for tests. */
export type FetchLike = typeof fetch;

/** Minimal pino-like logger. Defaults to a no-op implementation. */
export interface EspnLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface EspnClientOptions {
  leagueId: number;
  cookies?: EspnCookies;
  /** Defaults to global `fetch`. Inject a mock in tests — no real network calls in tests. */
  fetchImpl?: FetchLike;
  /** Defaults to a no-op logger. */
  logger?: EspnLogger;
  /** Defaults to a real `setTimeout`-based sleep. Inject a fake in tests so backoff runs instantly. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface FetchLeagueParams {
  season: number;
  views: EspnView[];
  /** Optional week-scoped fetch. */
  scoringPeriodId?: number;
  /**
   * Filter object serialized into the `x-fantasy-filter` header, required by
   * `kona_player_info`. Passed through as-is; the client only serializes it.
   */
  filter?: unknown;
}

export interface FetchLeagueResult {
  /** Raw response body text EXACTLY as received — archive this verbatim. */
  payload: string;
  /**
   * Parsed JSON body. For the history endpoint (which returns a one-element
   * array) this is the unwrapped single league object; `payload` still holds
   * the raw array text.
   */
  json: unknown;
  /** The URL that ultimately produced this successful response. */
  url: string;
  status: number;
}

/** Base class for all errors raised by the ESPN client. */
export class EspnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EspnError";
  }
}

/** Non-OK HTTP response that isn't an auth failure (4xx other than 401/403, or retries exhausted on 429/5xx). */
export class EspnHttpError extends EspnError {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string, message?: string) {
    super(message ?? `ESPN request failed with status ${status}: ${url}`);
    this.name = "EspnHttpError";
    this.status = status;
    this.url = url;
  }
}

/** Both the primary and alternate (modern/history) endpoint forms returned 401/403. */
export class EspnAuthError extends EspnHttpError {
  constructor(status: number, url: string) {
    super(status, url, `ESPN authentication failed (status ${status}) for ${url}`);
    this.name = "EspnAuthError";
  }
}

/**
 * A 2xx response body that could not be turned into usable league JSON:
 * either it failed to parse as JSON at all (ESPN sometimes returns an HTML
 * error page with 200), or — for the history endpoint — it parsed fine but
 * was an empty array containing no league object.
 */
export class EspnParseError extends EspnError {
  readonly url: string;
  /** First 200 chars of the raw response body, for debugging. */
  readonly snippet: string;

  constructor(url: string, snippet: string, message?: string) {
    super(message ?? `ESPN response was not valid JSON for ${url}: ${snippet}`);
    this.name = "EspnParseError";
    this.url = url;
    this.snippet = snippet;
  }
}
