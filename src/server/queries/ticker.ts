import { getDb } from "../db/client";
import { matchups } from "../db/schema";
import { getCurrentBeltHolder } from "./belt";
import { getChampion, getDraftCountdown, getTopRecord } from "./home";
import { computeLatestCompleteSeason } from "./identity";
import { computeLatestMatchupWeek, getWeekMatchupRows, type WeekSignal } from "./matchups";
import { getSeasonOptions, type SeasonOption } from "./standings";

// ---------------------------------------------------------------------------
// Season phase — README Shell: "Season-aware: in-season -> LIVE tab (final
// scores), offseason -> OFFSEASON tab (league facts)."
// ---------------------------------------------------------------------------

export type SeasonPhase = "in-season" | "offseason";

/**
 * The newest season's status decides the site-wide phase: "active" is
 * in-season (LIVE ticker), "upcoming"/"complete" is offseason. No seasons at
 * all defaults to offseason. Pure — unit-tested directly. Derived from the
 * same season signal every other page uses (getSeasonOptions().status), not
 * a manual flag, per the README/brief.
 */
export function computeSeasonPhase(seasonOptions: SeasonOption[]): SeasonPhase {
  if (seasonOptions.length === 0) return "offseason";
  const newest = [...seasonOptions].sort((a, b) => b.season - a.season)[0]!;
  return newest.status === "active" ? "in-season" : "offseason";
}

// ---------------------------------------------------------------------------
// Ticker content
// ---------------------------------------------------------------------------

export interface TickerGameItem {
  kind: "game";
  matchupId: number;
  homeFranchiseId: number;
  homeName: string;
  homeScore: number | null;
  awayFranchiseId: number | null;
  awayName: string | null;
  awayScore: number | null;
  isFinal: boolean;
  isBeltGame: boolean;
  isViewerGame: boolean;
}

export interface TickerFactItem {
  kind: "fact";
  label: string;
  /** Set together with franchiseName — a fact about a single franchise (belt holder, champion)
   * gets its full identity treatment (gold name / belt mark) via FranchiseName. Null for facts
   * with no single franchise subject (draft countdown) or where the underlying query doesn't
   * resolve an id (record leader — see getTopRecord's RecordTeaser, name-only). */
  franchiseId: number | null;
  franchiseName: string | null;
  /** Extra text after the name when franchiseId is set (e.g. "3 defenses"); the FULL display
   * text when franchiseId is null (e.g. "25 days · 2026-08-29"). */
  detail: string;
}

export type TickerItemData = TickerGameItem | TickerFactItem;

export interface TickerContent {
  phase: SeasonPhase;
  items: TickerItemData[];
}

/** In-season: the current week's games, belt game first — reuses getWeekMatchupRows' own
 * belt-at-stake resolution rather than re-deriving it. */
function buildInSeasonItems(viewerFranchiseId: number | null): TickerGameItem[] {
  const db = getDb();
  const signalRows = db.select({ season: matchups.season, week: matchups.week, isFinal: matchups.isFinal }).from(matchups).all();
  const byKey = new Map<string, WeekSignal>();
  for (const r of signalRows) {
    const key = `${r.season}:${r.week}`;
    const existing = byKey.get(key);
    if (existing) existing.hasFinal = existing.hasFinal || r.isFinal;
    else byKey.set(key, { season: r.season, week: r.week, hasFinal: r.isFinal });
  }
  const target = computeLatestMatchupWeek([...byKey.values()]);
  if (!target) return [];

  const rows = getWeekMatchupRows(target.season, target.week);
  const items: TickerGameItem[] = rows.map((r) => ({
    kind: "game",
    matchupId: r.matchupId,
    homeFranchiseId: r.home.franchiseId,
    homeName: r.home.name,
    homeScore: r.home.score,
    awayFranchiseId: r.away?.franchiseId ?? null,
    awayName: r.away?.name ?? null,
    awayScore: r.away?.score ?? null,
    isFinal: r.isFinal,
    isBeltGame: r.beltAtStake,
    isViewerGame: viewerFranchiseId !== null && (r.home.franchiseId === viewerFranchiseId || r.away?.franchiseId === viewerFranchiseId),
  }));
  // Belt game leads, per README's matchup-card ranking rule reused here.
  return items.sort((a, b) => Number(b.isBeltGame) - Number(a.isBeltGame));
}

/** Offseason: league facts — belt holder, reigning champion, draft countdown, a record leader. */
function buildOffseasonItems(): TickerFactItem[] {
  const items: TickerFactItem[] = [];

  const holder = getCurrentBeltHolder();
  if (holder) {
    items.push({
      kind: "fact",
      label: "Belt",
      franchiseId: holder.franchiseId,
      franchiseName: holder.franchiseName,
      detail: `${holder.defenses} defense${holder.defenses === 1 ? "" : "s"}`,
    });
  }

  const seasonOptions = getSeasonOptions();
  const latestComplete = computeLatestCompleteSeason(seasonOptions);
  if (latestComplete !== null) {
    const champion = getChampion(latestComplete);
    if (champion) {
      items.push({ kind: "fact", label: `${latestComplete} Champion`, franchiseId: champion.franchiseId, franchiseName: champion.franchiseName, detail: "" });
    }
  }

  const countdown = getDraftCountdown();
  items.push({
    kind: "fact",
    label: "Draft",
    franchiseId: null,
    franchiseName: null,
    detail: countdown.daysRemaining >= 0 ? `${countdown.daysRemaining} days · ${countdown.targetDateIso}` : countdown.targetDateIso,
  });

  // getTopRecord's RecordTeaser is name-only (no franchiseId) — this fact stays plain text, not
  // routed through FranchiseName, until that query resolves an id too.
  const topScore = getTopRecord("highest_week_score");
  if (topScore) {
    items.push({
      kind: "fact",
      label: "Record",
      franchiseId: null,
      franchiseName: null,
      detail: `${topScore.franchiseName} · ${topScore.value.toFixed(1)} (${topScore.season}${topScore.week ? ` Wk ${topScore.week}` : ""})`,
    });
  }

  return items;
}

/** Builds the shell ticker's full content — plain data only (no JSX); the caller
 * (components/layout/SeasonTicker.tsx) renders FranchiseName marks around it. */
export function getTickerContent(viewerFranchiseId: number | null): TickerContent {
  const seasonOptions = getSeasonOptions();
  const phase = computeSeasonPhase(seasonOptions);
  const items = phase === "in-season" ? buildInSeasonItems(viewerFranchiseId) : buildOffseasonItems();
  return { phase, items };
}
