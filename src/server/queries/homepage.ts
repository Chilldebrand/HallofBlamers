import { eq } from "drizzle-orm";
import type { RecordKey } from "@/engines";
import { getDb } from "../db/client";
import { eloHistory, franchises } from "../db/schema";
import { getCurrentBeltHolder } from "./belt";
import { computeLatestCompleteSeason } from "./identity";
import { getChampion, getDraftCountdown, getEloTop, getTopRecord } from "./home";
import { getLatestMatchupWeek, getWeekMatchupRows } from "./matchups";
import { RECORD_KEY_META } from "./records";
import { getSeasonOptions, getStandingsReal } from "./standings";

/**
 * Home page (`src/app/(league)/page.tsx`) composition layer — docs/design/redesign-2026-08/README.md
 * "2. Home". Every function here is a thin READ composed from already-tested query functions
 * (getStandingsReal, getWeekMatchupRows, getCurrentBeltHolder, getChampion, getDraftCountdown,
 * getEloTop, getTopRecord); the genuinely NEW logic is the handful of small pure helpers
 * (selectScoreboardRows, computeEloDeltas, computeDefensePips, formatDraftDateShort) — those are
 * unit-tested directly in homepage.test.ts, mirroring the codebase's established pattern of
 * colocating pure helpers next to the query functions that use them (see standings.ts's
 * computeStreak/computeCloseGames, seasons.ts's computeSeasonSuperlatives, ticker.ts's
 * computeSeasonPhase). Identity flags (isChampion/holdsBelt/isSacko/isViewer) are NEVER resolved
 * here — every function below returns a plain franchiseId + franchiseName; the page/components
 * resolve flags via resolveFranchiseFlags and render through FranchiseName, same as
 * SeasonTicker.tsx already does.
 */

// ---------------------------------------------------------------------------
// Scoreboard band — offseason ("N FINAL STANDINGS") / in-season (current week)
// ---------------------------------------------------------------------------

/**
 * Picks the (up to) 6 rows the offseason scoreboard band shows: the top 5 by rank, plus a
 * distinct last-place row when the league is bigger than 5 (never a duplicate of a row already
 * in the top 5). Pure — unit-tested directly against plain arrays, no DB. Assumes `rows` is
 * already sorted best-to-worst (getStandingsReal does this for a complete season).
 */
export function selectScoreboardRows<T>(rowsSortedByRank: T[]): { rank: number; row: T }[] {
  const n = rowsSortedByRank.length;
  const head = rowsSortedByRank.slice(0, Math.min(5, n)).map((row, i) => ({ rank: i + 1, row }));
  if (n > 5) return [...head, { rank: n, row: rowsSortedByRank[n - 1]! }];
  return head;
}

export interface OffseasonScoreboardCell {
  rank: number;
  label: string;
  franchiseId: number;
  franchiseName: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  /** rank === 1 — raised fill + gold top rule, per README. */
  isChampionCell: boolean;
}

export interface OffseasonScoreboard {
  season: number;
  cells: OffseasonScoreboardCell[];
}

/** Null when the league has never finished a season (fresh league, nothing to show yet). */
export function getOffseasonScoreboard(): OffseasonScoreboard | null {
  const season = computeLatestCompleteSeason(getSeasonOptions());
  if (season === null) return null;

  const rows = getStandingsReal(season);
  const teamCount = rows.length;
  const selected = selectScoreboardRows(rows);

  return {
    season,
    cells: selected.map(({ rank, row }) => ({
      rank,
      label: rank === 1 ? "1 · Champion" : rank === 2 ? "2 · Runner-up" : rank === teamCount ? `${rank} · Last` : `${rank}`,
      franchiseId: row.franchiseId,
      franchiseName: row.franchiseName,
      wins: row.wins,
      losses: row.losses,
      ties: row.ties,
      pointsFor: row.pointsFor,
      isChampionCell: rank === 1,
    })),
  };
}

export interface InSeasonScoreboardSide {
  franchiseId: number;
  name: string;
  score: number | null;
}

export interface InSeasonScoreboardCell {
  matchupId: number;
  isBeltGame: boolean;
  isViewerGame: boolean;
  isFinal: boolean;
  home: InSeasonScoreboardSide;
  away: InSeasonScoreboardSide | null;
}

export interface InSeasonScoreboard {
  season: number;
  week: number;
  cells: InSeasonScoreboardCell[];
}

/** Null when no week has ever been scheduled at all. Belt game (if any) sorts first, matching
 * the matchup-card ranking rule README specifies for the Matchups screen, reused here. */
export function getInSeasonScoreboard(viewerFranchiseId: number | null): InSeasonScoreboard | null {
  const target = getLatestMatchupWeek();
  if (!target) return null;

  const rows = getWeekMatchupRows(target.season, target.week);
  const sorted = [...rows].sort((a, b) => Number(b.beltAtStake) - Number(a.beltAtStake));

  return {
    season: target.season,
    week: target.week,
    cells: sorted.slice(0, 6).map((r) => ({
      matchupId: r.matchupId,
      isBeltGame: r.beltAtStake,
      isViewerGame: viewerFranchiseId !== null && (r.home.franchiseId === viewerFranchiseId || r.away?.franchiseId === viewerFranchiseId),
      isFinal: r.isFinal,
      home: { franchiseId: r.home.franchiseId, name: r.home.name, score: r.home.score },
      away: r.away ? { franchiseId: r.away.franchiseId, name: r.away.name, score: r.away.score } : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Lead column — eyebrow / headline / deck
// ---------------------------------------------------------------------------

export interface LeadCopy {
  eyebrow: string;
  headline: string;
  deck: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "2026-08-29" -> "Aug 29". Pure. */
export function formatDraftDateShort(iso: string): string {
  const [, month, day] = iso.split("-").map(Number);
  if (!month || !day || month < 1 || month > 12) return iso;
  return `${MONTHS[month - 1]} ${day}`;
}

/**
 * "2026-08-29" -> "Sat, Aug 29, 2026" — the weekday is real (derived from the date itself, not
 * fabricated), unlike the draft's time-of-day, which isn't stored anywhere real and is
 * deliberately never rendered here. UTC throughout so this can't drift between server/client
 * render (the date is a bare "YYYY-MM-DD" with no timezone of its own). Pure.
 */
export function formatDraftDateFull(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day || month < 1 || month > 12) return iso;
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = WEEKDAYS[date.getUTCDay()];
  return `${weekday}, ${MONTHS[month - 1]} ${day}, ${year}`;
}

/**
 * ONE tasteful default composition, entirely from real state — champion/belt/draft-date angle,
 * per the brief. The commissioner-notes/editorial override is explicitly out of scope for this
 * task; this is the only copy the page ever renders.
 */
export function getOffseasonLeadCopy(): LeadCopy {
  const season = computeLatestCompleteSeason(getSeasonOptions());
  const champion = season !== null ? getChampion(season) : null;
  const beltHolder = getCurrentBeltHolder();
  const countdown = getDraftCountdown();
  const draftDate = formatDraftDateShort(countdown.targetDateIso);

  const eyebrow = season !== null ? `The ${season} season · offseason` : "Offseason";
  const headline = champion ? `${champion.franchiseName} heads into the offseason on top` : `The countdown is on for the ${draftDate} draft`;
  const deck = beltHolder
    ? `${beltHolder.franchiseName} carries the belt into the ${draftDate} draft.`
    : `The belt sits vacant heading into the ${draftDate} draft.`;

  return { eyebrow, headline, deck };
}

export function getInSeasonLeadCopy(): LeadCopy {
  const target = getLatestMatchupWeek();
  if (!target) {
    return { eyebrow: "In season", headline: "The season is underway", deck: "Matchups will appear here once the week is set." };
  }

  const rows = getWeekMatchupRows(target.season, target.week);
  const beltRow = rows.find((r) => r.beltAtStake);
  const holder = getCurrentBeltHolder();
  const eyebrow = beltRow ? `Week ${target.week} · the belt is live` : `Week ${target.week}`;

  if (beltRow && holder) {
    const holderIsHome = beltRow.home.franchiseId === holder.franchiseId;
    const challengerName = holderIsHome ? (beltRow.away?.name ?? "—") : beltRow.home.name;
    return {
      eyebrow,
      headline: `${holder.franchiseName} defends the belt against ${challengerName}`,
      deck: `${challengerName} looks to take the title in Week ${target.week}.`,
    };
  }

  const gameCount = rows.length;
  return {
    eyebrow,
    headline: `Week ${target.week} is underway`,
    deck: `${gameCount} matchup${gameCount === 1 ? "" : "s"} on the board this week.`,
  };
}

// ---------------------------------------------------------------------------
// Rail — power ladder (Elo + delta vs prior week)
// ---------------------------------------------------------------------------

interface EloHistoryRow {
  franchiseId: number;
  season: number;
  week: number;
  eloPost: number;
}

/**
 * Delta vs the immediately prior recorded week, per franchise — null when a franchise has fewer
 * than two elo_history rows (nothing to compare against yet), never a fabricated ±0. Pure —
 * unit-tested directly against plain fixture rows.
 */
export function computeEloDeltas(rows: EloHistoryRow[]): Map<number, number | null> {
  const byFranchise = new Map<number, EloHistoryRow[]>();
  for (const r of rows) {
    const list = byFranchise.get(r.franchiseId) ?? [];
    list.push(r);
    byFranchise.set(r.franchiseId, list);
  }

  const out = new Map<number, number | null>();
  for (const [franchiseId, list] of byFranchise) {
    const sorted = [...list].sort((a, b) => a.season - b.season || a.week - b.week);
    if (sorted.length < 2) {
      out.set(franchiseId, null);
      continue;
    }
    const last = sorted[sorted.length - 1]!;
    const prior = sorted[sorted.length - 2]!;
    out.set(franchiseId, last.eloPost - prior.eloPost);
  }
  return out;
}

export interface PowerLadderRow {
  rank: number;
  franchiseId: number;
  name: string;
  elo: number;
  /** vs the immediately prior recorded week; null when there isn't one yet. */
  delta: number | null;
}

export interface PowerLadder {
  rows: PowerLadderRow[];
  /** Count of currently-active franchises — feeds the "All N →" phone link. */
  totalActive: number;
}

export function getPowerLadder(limit = 8): PowerLadder {
  const db = getDb();
  const historyRows: EloHistoryRow[] = db
    .select({ franchiseId: eloHistory.franchiseId, season: eloHistory.season, week: eloHistory.week, eloPost: eloHistory.eloPost })
    .from(eloHistory)
    .all();
  const deltas = computeEloDeltas(historyRows);

  const top = getEloTop(limit);
  const totalActive = db.select({ id: franchises.id }).from(franchises).where(eq(franchises.active, true)).all().length;

  return {
    rows: top.map((r, i) => ({ rank: i + 1, franchiseId: r.franchiseId, name: r.name, elo: r.elo, delta: deltas.get(r.franchiseId) ?? null })),
    totalActive,
  };
}

// ---------------------------------------------------------------------------
// Rail — season-dependent card: draft countdown (offseason) reuses
// getDraftCountdown() directly (see page.tsx); "your week" (in-season) below.
// ---------------------------------------------------------------------------

export interface YourWeekCard {
  season: number;
  week: number;
  opponentFranchiseId: number | null;
  opponentName: string | null;
  isFinal: boolean;
  myScore: number | null;
  oppScore: number | null;
  myProjected: number | null;
  oppProjected: number | null;
}

/**
 * The viewer's own current-week matchup — real scores when final, real precomputed projections
 * (matchups.home_projected/away_projected, NOT live win-probability — that field belongs to the
 * live-sync layer, out of scope here) when not. Null when there's no signed-in franchise, no
 * scheduled week at all, or the viewer's franchise has a bye this week.
 */
export function getYourWeekCard(viewerFranchiseId: number | null): YourWeekCard | null {
  if (viewerFranchiseId === null) return null;
  const target = getLatestMatchupWeek();
  if (!target) return null;

  const rows = getWeekMatchupRows(target.season, target.week);
  const mine = rows.find((r) => r.home.franchiseId === viewerFranchiseId || r.away?.franchiseId === viewerFranchiseId);
  if (!mine) return null;

  const iAmHome = mine.home.franchiseId === viewerFranchiseId;
  const my = iAmHome ? mine.home : mine.away;
  const opp = iAmHome ? mine.away : mine.home;
  if (!my) return null;

  return {
    season: target.season,
    week: target.week,
    opponentFranchiseId: opp?.franchiseId ?? null,
    opponentName: opp?.name ?? null,
    isFinal: mine.isFinal,
    myScore: my.score,
    oppScore: opp?.score ?? null,
    myProjected: my.projected,
    oppProjected: opp?.projected ?? null,
  };
}

// ---------------------------------------------------------------------------
// Belt card — defense pips
// ---------------------------------------------------------------------------

/**
 * Segment count for the belt card's defense-pips row: one filled segment per defense, plus at
 * least one trailing empty segment (room for "the next one"), floored at 4 total and capped at 8
 * so a long reign never produces an absurdly wide row. Pure — unit-tested directly.
 */
export function computeDefensePips(defenses: number): { total: number; filled: number } {
  const total = Math.min(Math.max(defenses + 1, 4), 8);
  const filled = Math.min(defenses, total);
  return { total, filled };
}

// ---------------------------------------------------------------------------
// Record strip — 4 cells from record_entries rank 1s
// ---------------------------------------------------------------------------

const RECORD_STRIP_KEYS: RecordKey[] = ["highest_week_score", "largest_blowout", "longest_win_streak", "longest_belt_reign"];

export interface RecordStripCell {
  key: RecordKey;
  label: string;
  value: string;
  franchiseName: string | null;
  season: number | null;
  week: number | null;
}

/**
 * Franchise name here stays plain text (no FranchiseName/identity marks) — getTopRecord's
 * RecordTeaser is name-only, no franchiseId, so there's nothing to resolve flags against. Same
 * limitation, same reasoning, as the ticker's own record-leader fact (server/queries/ticker.ts).
 */
export function getRecordStrip(): RecordStripCell[] {
  return RECORD_STRIP_KEYS.map((key) => {
    const record = getTopRecord(key);
    const meta = RECORD_KEY_META[key];
    return {
      key,
      label: meta.label,
      value: record ? meta.format(record.value) : "—",
      franchiseName: record?.franchiseName ?? null,
      season: record?.season ?? null,
      week: record?.week ?? null,
    };
  });
}
