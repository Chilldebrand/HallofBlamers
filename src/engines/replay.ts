/**
 * ONE chronological pass over every completed head-to-head matchup (byes are
 * not events — callers simply never include them), producing Elo history,
 * the lineal belt's reign/match lineage, and per-franchise win/loss streaks.
 * Pure per AGENTS.md: no DB, no IO. `matchupsInput` is sorted defensively
 * (season asc, week asc, matchupId asc) even if the caller already sorted it.
 */

export type ReplayWeekType = "regular" | "playoff" | "consolation" | "championship";

export interface ReplayMatchupInput {
  matchupId: number;
  season: number;
  week: number;
  weekType: ReplayWeekType;
  homeFranchiseId: number;
  awayFranchiseId: number;
  homeScore: number;
  awayScore: number;
  winner: "home" | "away" | "tie";
}

export interface ReplayChampion {
  season: number;
  franchiseId: number;
  /** The week their championship-deciding matchup was played. */
  week: number;
}

export interface ReplayBeltOverride {
  season: number;
  week: number;
  /** The franchise the belt is manually assigned to as of this (season, week). */
  franchiseId: number;
  reason?: string;
}

export interface ReplayOptions {
  /** One entry per season with a determinable champion, in any order — the engine sorts them. */
  champions: ReplayChampion[];
  /** season -> franchise ids with a team_season that season (belt departure/vacancy detection). */
  activeFranchisesBySeason: Record<number, number[]>;
  beltOverrides?: ReplayBeltOverride[];
}

export interface EloHistoryEntry {
  franchiseId: number;
  season: number;
  week: number;
  eloPre: number;
  eloPost: number;
}

export interface FranchiseEloSummary {
  franchiseId: number;
  current: number;
  peak: number;
  peakSeason: number;
  peakWeek: number;
  trough: number;
  weeksAtNo1: number;
}

export type BeltEndReason = "lost" | "vacated" | "override";

export interface BeltReignOutput {
  reignNo: number;
  franchiseId: number;
  /** Null for the very first reign, and for a vacancy award (won the championship into a vacant title, not by beating a holder). */
  wonFromFranchiseId: number | null;
  startSeason: number;
  startWeek: number;
  endSeason: number | null;
  endWeek: number | null;
  defenses: number;
  weeksHeld: number;
  endReason: BeltEndReason | null;
  isCurrent: boolean;
}

export interface BeltMatchOutput {
  matchupId: number;
  season: number;
  week: number;
  /** The holder GOING INTO this matchup (pre-transfer, if it transfers). */
  holderFranchiseId: number;
  challengerFranchiseId: number;
  result: "defense" | "transfer";
  holderScore: number;
  challengerScore: number;
}

export interface StreakSpan {
  count: number;
  startSeason: number;
  startWeek: number;
  endSeason: number;
  endWeek: number;
}

export interface FranchiseStreakSummary {
  franchiseId: number;
  currentStreakType: "W" | "L" | null;
  currentStreakCount: number;
  longestWinStreak: StreakSpan | null;
  longestLossStreak: StreakSpan | null;
}

/** Per-(franchise, season, week) snapshot of the active streak AS OF that week — a side artifact
 * of the same chronological pass that computes `FranchiseStreakSummary`. No entry is emitted for
 * an excluded (consolation) game — same exclusion as the streak-summary logic itself. Added for
 * Task 12's `streak_context` context-engine rule, which needs to annotate every historical week
 * with its streak state at that point, not just each franchise's final summary. */
export interface StreakHistoryEntry {
  franchiseId: number;
  season: number;
  week: number;
  streakType: "W" | "L" | null;
  streakCount: number;
}

export interface ReplayResult {
  eloHistory: EloHistoryEntry[];
  franchiseElo: FranchiseEloSummary[];
  beltReigns: BeltReignOutput[];
  beltMatches: BeltMatchOutput[];
  streaks: FranchiseStreakSummary[];
  streakHistory: StreakHistoryEntry[];
  warnings: string[];
}

export const ELO_START = 1500;
export const ELO_SEASON_REGRESSION_FACTOR = 2 / 3;

/** K by week type — 'championship' groups with 'playoff' (real data never emits it separately, but the schema allows it). */
export function eloKFactor(weekType: ReplayWeekType): number {
  if (weekType === "playoff" || weekType === "championship") return 40;
  if (weekType === "consolation") return 16;
  return 32;
}

/** E = 1/(1+10^(-Δ/400)), Δ = ownElo - opponentElo. */
export function eloExpected(ownElo: number, opponentElo: number): number {
  return 1 / (1 + Math.pow(10, -(ownElo - opponentElo) / 400));
}

/**
 * 538-style margin-of-victory multiplier. `deltaWinner` = winner's pre-game Elo minus loser's
 * pre-game Elo (0 for a tie — moot anyway since a tie's margin is definitionally 0, which alone
 * zeroes the multiplier). A bigger favorite winning by the same margin gets a SMALLER multiplier
 * (the denominator grows with deltaWinner) — "as expected" results move Elo less than upsets do.
 */
export function eloMarginMultiplier(margin: number, deltaWinner: number): number {
  return (Math.log(Math.abs(margin) + 1) * 2.2) / (0.001 * deltaWinner + 2.2);
}

interface WeekGroup {
  season: number;
  week: number;
  matchups: ReplayMatchupInput[];
}

function groupByWeek(sorted: ReplayMatchupInput[]): WeekGroup[] {
  const groups: WeekGroup[] = [];
  for (const m of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.season === m.season && last.week === m.week) last.matchups.push(m);
    else groups.push({ season: m.season, week: m.week, matchups: [m] });
  }
  return groups;
}

function resultFor(m: ReplayMatchupInput, isHome: boolean): "W" | "L" | "T" {
  if (m.winner === "tie") return "T";
  if (m.winner === "home") return isHome ? "W" : "L";
  return isHome ? "L" : "W";
}

interface StreakState {
  type: "W" | "L" | null;
  count: number;
  startSeason: number;
  startWeek: number;
  longestWin: StreakSpan | null;
  longestLoss: StreakSpan | null;
}

interface ReignState {
  reignNo: number;
  franchiseId: number;
  wonFromFranchiseId: number | null;
  startSeason: number;
  startWeek: number;
  defenses: number;
}

export function replay(matchupsInput: ReplayMatchupInput[], options: ReplayOptions): ReplayResult {
  const warnings: string[] = [];
  const sorted = [...matchupsInput].sort(
    (a, b) => a.season - b.season || a.week - b.week || a.matchupId - b.matchupId,
  );
  const weekGroups = groupByWeek(sorted);

  // ---------------------------------------------------------------------
  // Elo
  // ---------------------------------------------------------------------
  const eloCurrent = new Map<number, number>();
  const eloLastSeason = new Map<number, number>();
  const eloPeak = new Map<number, { value: number; season: number; week: number }>();
  const eloTrough = new Map<number, number>();
  const weeksAtNo1 = new Map<number, number>();
  const eloHistory: EloHistoryEntry[] = [];

  function ensureFranchiseSeen(franchiseId: number, season: number): void {
    if (!eloCurrent.has(franchiseId)) {
      eloCurrent.set(franchiseId, ELO_START);
      eloLastSeason.set(franchiseId, season);
      return;
    }
    const lastSeason = eloLastSeason.get(franchiseId)!;
    if (lastSeason !== season) {
      const cur = eloCurrent.get(franchiseId)!;
      eloCurrent.set(franchiseId, ELO_START + (cur - ELO_START) * ELO_SEASON_REGRESSION_FACTOR);
      eloLastSeason.set(franchiseId, season);
    }
  }

  function recordEloExtremes(franchiseId: number, season: number, week: number, post: number): void {
    const peak = eloPeak.get(franchiseId);
    if (!peak || post > peak.value) eloPeak.set(franchiseId, { value: post, season, week });
    const trough = eloTrough.get(franchiseId);
    if (trough === undefined || post < trough) eloTrough.set(franchiseId, post);
  }

  // ---------------------------------------------------------------------
  // Belt
  // ---------------------------------------------------------------------
  const championsAsc = [...options.champions].sort((a, b) => a.season - b.season);
  const championBySeason = new Map(championsAsc.map((c) => [c.season, c]));
  const overridesSorted = [...(options.beltOverrides ?? [])].sort((a, b) => a.season - b.season || a.week - b.week);
  let overrideIdx = 0;

  const maxWeekBySeason = new Map<number, number>();
  for (const m of sorted) maxWeekBySeason.set(m.season, Math.max(maxWeekBySeason.get(m.season) ?? 0, m.week));

  const weekOrdinal = new Map<string, number>();
  weekGroups.forEach((g, i) => weekOrdinal.set(`${g.season}:${g.week}`, i));
  function ordinalOf(season: number, week: number): number {
    return weekOrdinal.get(`${season}:${week}`) ?? 0;
  }
  function weeksHeldFor(startSeason: number, startWeek: number, endSeason: number, endWeek: number): number {
    return ordinalOf(endSeason, endWeek) - ordinalOf(startSeason, startWeek) + 1;
  }

  let holder: number | null = null;
  let reignCounter = 0;
  let currentReign: ReignState | null = null;
  const finishedReigns: BeltReignOutput[] = [];
  const beltMatches: BeltMatchOutput[] = [];

  function startReign(franchiseId: number, wonFrom: number | null, season: number, week: number): void {
    reignCounter += 1;
    currentReign = { reignNo: reignCounter, franchiseId, wonFromFranchiseId: wonFrom, startSeason: season, startWeek: week, defenses: 0 };
    holder = franchiseId;
  }

  function endReign(season: number, week: number, reason: BeltEndReason): void {
    if (!currentReign) return;
    const cr = currentReign;
    finishedReigns.push({
      reignNo: cr.reignNo,
      franchiseId: cr.franchiseId,
      wonFromFranchiseId: cr.wonFromFranchiseId,
      startSeason: cr.startSeason,
      startWeek: cr.startWeek,
      endSeason: season,
      endWeek: week,
      defenses: cr.defenses,
      weeksHeld: weeksHeldFor(cr.startSeason, cr.startWeek, season, week),
      endReason: reason,
      isCurrent: false,
    });
    currentReign = null;
    holder = null;
  }

  // Deliberately NOT seeded before the loop: `holder` starts genuinely null, so the very first
  // reign is established by the exact same "vacancy award" branch below as every later
  // re-establishment (the earliest season with a champion is just a vacancy that's always been
  // there). That means every one of that season's OWN games — including the championship game
  // that crowns them — correctly falls under "holder === null, nothing at stake yet", with no
  // special-casing needed to keep the belt from applying to games that precede its own creation.
  if (championsAsc.length === 0) {
    warnings.push("replay: no champions supplied in options — belt tracking produces no reigns");
  }

  let lastSeasonForVacancyCheck: number | null = null;

  // ---------------------------------------------------------------------
  // Streaks (regular + playoff/championship only; consolation excluded)
  // ---------------------------------------------------------------------
  const streakHistory: StreakHistoryEntry[] = [];
  const streakState = new Map<number, StreakState>();
  function ensureStreak(franchiseId: number): StreakState {
    let s = streakState.get(franchiseId);
    if (!s) {
      s = { type: null, count: 0, startSeason: 0, startWeek: 0, longestWin: null, longestLoss: null };
      streakState.set(franchiseId, s);
    }
    return s;
  }
  function applyStreak(franchiseId: number, result: "W" | "L" | "T", season: number, week: number): void {
    const s = ensureStreak(franchiseId);
    if (result === "T") {
      s.type = null;
      s.count = 0;
      return;
    }
    if (s.type === result) {
      s.count += 1;
    } else {
      s.type = result;
      s.count = 1;
      s.startSeason = season;
      s.startWeek = week;
    }
    const span: StreakSpan = { count: s.count, startSeason: s.startSeason, startWeek: s.startWeek, endSeason: season, endWeek: week };
    if (result === "W") {
      if (!s.longestWin || span.count > s.longestWin.count) s.longestWin = span;
    } else {
      if (!s.longestLoss || span.count > s.longestLoss.count) s.longestLoss = span;
    }
  }

  // ---------------------------------------------------------------------
  // Main pass
  // ---------------------------------------------------------------------
  for (const group of weekGroups) {
    if (holder !== null && lastSeasonForVacancyCheck !== null && group.season !== lastSeasonForVacancyCheck) {
      const activeSet = new Set(options.activeFranchisesBySeason[group.season] ?? []);
      if (!activeSet.has(holder)) {
        const lastActiveSeason = group.season - 1;
        endReign(lastActiveSeason, maxWeekBySeason.get(lastActiveSeason) ?? currentReign!.startWeek, "vacated");
        if (!championBySeason.has(group.season)) {
          warnings.push(
            `belt: vacated entering season ${group.season} (previous holder's franchise departed) but no champion is recorded for season ${group.season} yet — belt stays vacant until one is`,
          );
        }
      }
    }
    lastSeasonForVacancyCheck = group.season;

    // Manual overrides scheduled at/before this (season, week), applied in order.
    while (overrideIdx < overridesSorted.length) {
      const o = overridesSorted[overrideIdx]!;
      if (o.season > group.season || (o.season === group.season && o.week > group.week)) break;
      const previousHolder = holder;
      if (currentReign) endReign(o.season, o.week, "override");
      startReign(o.franchiseId, previousHolder, o.season, o.week);
      overrideIdx++;
    }

    for (const m of group.matchups) {
      // --- Elo ---
      ensureFranchiseSeen(m.homeFranchiseId, m.season);
      ensureFranchiseSeen(m.awayFranchiseId, m.season);
      const homePre = eloCurrent.get(m.homeFranchiseId)!;
      const awayPre = eloCurrent.get(m.awayFranchiseId)!;
      const eHome = eloExpected(homePre, awayPre);
      const eAway = 1 - eHome;
      const margin = Math.abs(m.homeScore - m.awayScore);

      let sHome: number;
      let sAway: number;
      let deltaWinner: number;
      if (m.winner === "tie") {
        sHome = 0.5;
        sAway = 0.5;
        deltaWinner = 0;
      } else if (m.winner === "home") {
        sHome = 1;
        sAway = 0;
        deltaWinner = homePre - awayPre;
      } else {
        sHome = 0;
        sAway = 1;
        deltaWinner = awayPre - homePre;
      }
      const mult = eloMarginMultiplier(margin, deltaWinner);
      const k = eloKFactor(m.weekType);
      const homePost = homePre + k * mult * (sHome - eHome);
      const awayPost = awayPre + k * mult * (sAway - eAway);

      eloCurrent.set(m.homeFranchiseId, homePost);
      eloCurrent.set(m.awayFranchiseId, awayPost);
      eloHistory.push({ franchiseId: m.homeFranchiseId, season: m.season, week: m.week, eloPre: homePre, eloPost: homePost });
      eloHistory.push({ franchiseId: m.awayFranchiseId, season: m.season, week: m.week, eloPre: awayPre, eloPost: awayPost });
      recordEloExtremes(m.homeFranchiseId, m.season, m.week, homePost);
      recordEloExtremes(m.awayFranchiseId, m.season, m.week, awayPost);

      // --- Belt ---
      if (holder === null) {
        const champ = championBySeason.get(m.season);
        if (champ && champ.week === m.week && (m.homeFranchiseId === champ.franchiseId || m.awayFranchiseId === champ.franchiseId)) {
          startReign(champ.franchiseId, null, m.season, m.week); // vacancy award, not a transfer
        }
      } else if (m.homeFranchiseId === holder || m.awayFranchiseId === holder) {
        const holderIsHome = m.homeFranchiseId === holder;
        const holderAtStart = holder;
        const opponent = holderIsHome ? m.awayFranchiseId : m.homeFranchiseId;
        const holderScore = holderIsHome ? m.homeScore : m.awayScore;
        const challengerScore = holderIsHome ? m.awayScore : m.homeScore;

        let result: "defense" | "transfer";
        if (m.winner === "tie") {
          result = "defense";
          currentReign!.defenses += 1;
        } else {
          const holderWon = (holderIsHome && m.winner === "home") || (!holderIsHome && m.winner === "away");
          if (holderWon) {
            result = "defense";
            currentReign!.defenses += 1;
          } else {
            result = "transfer";
            endReign(m.season, m.week, "lost");
            startReign(opponent, holderAtStart, m.season, m.week);
          }
        }

        beltMatches.push({
          matchupId: m.matchupId,
          season: m.season,
          week: m.week,
          holderFranchiseId: holderAtStart,
          challengerFranchiseId: opponent,
          result,
          holderScore,
          challengerScore,
        });
      }

      // --- Streaks ---
      if (m.weekType !== "consolation") {
        applyStreak(m.homeFranchiseId, resultFor(m, true), m.season, m.week);
        applyStreak(m.awayFranchiseId, resultFor(m, false), m.season, m.week);
        const homeState = ensureStreak(m.homeFranchiseId);
        const awayState = ensureStreak(m.awayFranchiseId);
        streakHistory.push({ franchiseId: m.homeFranchiseId, season: m.season, week: m.week, streakType: homeState.type, streakCount: homeState.count });
        streakHistory.push({ franchiseId: m.awayFranchiseId, season: m.season, week: m.week, streakType: awayState.type, streakCount: awayState.count });
      }
    }

    // weeks_at_no1: evaluated once per real week, across every franchise seen so far.
    if (eloCurrent.size > 0) {
      let max = Number.NEGATIVE_INFINITY;
      for (const v of eloCurrent.values()) if (v > max) max = v;
      for (const [fid, v] of eloCurrent) {
        if (v === max) weeksAtNo1.set(fid, (weeksAtNo1.get(fid) ?? 0) + 1);
      }
    }
  }

  if (currentReign) {
    // Type assertion (not just the `if` narrowing) deliberately: `currentReign` is reassigned
    // exclusively inside the `startReign`/`endReign` closures above, and TS's control-flow
    // analysis for `let` bindings mutated only through nested functions doesn't reliably narrow
    // this correctly this far down the function body.
    const cr = currentReign as ReignState;
    const lastGroup = weekGroups[weekGroups.length - 1];
    finishedReigns.push({
      reignNo: cr.reignNo,
      franchiseId: cr.franchiseId,
      wonFromFranchiseId: cr.wonFromFranchiseId,
      startSeason: cr.startSeason,
      startWeek: cr.startWeek,
      endSeason: null,
      endWeek: null,
      defenses: cr.defenses,
      weeksHeld: lastGroup ? weeksHeldFor(cr.startSeason, cr.startWeek, lastGroup.season, lastGroup.week) : 1,
      endReason: null,
      isCurrent: true,
    });
  }

  const streaks: FranchiseStreakSummary[] = [...streakState.entries()].map(([franchiseId, s]) => ({
    franchiseId,
    currentStreakType: s.type,
    currentStreakCount: s.count,
    longestWinStreak: s.longestWin,
    longestLossStreak: s.longestLoss,
  }));

  const franchiseElo: FranchiseEloSummary[] = [...eloCurrent.entries()].map(([franchiseId, current]) => {
    const peak = eloPeak.get(franchiseId)!;
    return {
      franchiseId,
      current,
      peak: peak.value,
      peakSeason: peak.season,
      peakWeek: peak.week,
      trough: eloTrough.get(franchiseId)!,
      weeksAtNo1: weeksAtNo1.get(franchiseId) ?? 0,
    };
  });

  finishedReigns.sort((a, b) => a.reignNo - b.reignNo);

  return { eloHistory, franchiseElo, beltReigns: finishedReigns, beltMatches, streaks, streakHistory, warnings };
}
