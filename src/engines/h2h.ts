/**
 * Per-unordered-franchise-pair head-to-head history. Pure per AGENTS.md: no
 * DB, no IO. Consolation-bracket games are excluded entirely (not counted
 * in either the regular or playoff bucket, and not folded into
 * points/margin/streak/largest-win/closest-game/last-meeting either) — a
 * placement game after elimination isn't part of the two franchises'
 * competitive rivalry record.
 */

export type H2HWeekType = "regular" | "playoff" | "consolation" | "championship";

export interface H2HMatchupInput {
  matchupId: number;
  season: number;
  week: number;
  weekType: H2HWeekType;
  homeFranchiseId: number;
  awayFranchiseId: number;
  homeScore: number;
  awayScore: number;
  winner: "home" | "away" | "tie";
}

export interface H2HLargestWin {
  winnerFranchiseId: number;
  value: number;
  season: number;
  week: number;
}

export interface H2HClosestGame {
  season: number;
  week: number;
  margin: number;
}

export interface H2HLastMeeting {
  season: number;
  week: number;
}

export interface H2HPairResult {
  /** franchiseA < franchiseB (unordered pair, normalized). */
  franchiseA: number;
  franchiseB: number;
  /** Win/loss/tie counts are from franchiseA's perspective. */
  regularW: number;
  regularL: number;
  regularT: number;
  playoffW: number;
  playoffL: number;
  playoffT: number;
  pointsA: number;
  pointsB: number;
  avgMargin: number;
  streakHolder: number | null;
  streakLen: number;
  largestWin: H2HLargestWin | null;
  closestGame: H2HClosestGame | null;
  lastMeeting: H2HLastMeeting | null;
}

interface PairAccumulator {
  franchiseA: number;
  franchiseB: number;
  regularW: number;
  regularL: number;
  regularT: number;
  playoffW: number;
  playoffL: number;
  playoffT: number;
  pointsA: number;
  pointsB: number;
  marginSum: number;
  gameCount: number;
  streakHolder: number | null;
  streakLen: number;
  largestWin: H2HLargestWin | null;
  closestGame: H2HClosestGame | null;
  lastMeeting: H2HLastMeeting | null;
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function buildH2HPairs(matchupsInput: H2HMatchupInput[]): H2HPairResult[] {
  const eligible = matchupsInput.filter((m) => m.weekType !== "consolation");
  const sorted = [...eligible].sort((a, b) => a.season - b.season || a.week - b.week || a.matchupId - b.matchupId);

  const byPair = new Map<string, PairAccumulator>();

  for (const m of sorted) {
    const franchiseA = Math.min(m.homeFranchiseId, m.awayFranchiseId);
    const franchiseB = Math.max(m.homeFranchiseId, m.awayFranchiseId);
    const key = pairKey(franchiseA, franchiseB);

    let acc = byPair.get(key);
    if (!acc) {
      acc = {
        franchiseA,
        franchiseB,
        regularW: 0,
        regularL: 0,
        regularT: 0,
        playoffW: 0,
        playoffL: 0,
        playoffT: 0,
        pointsA: 0,
        pointsB: 0,
        marginSum: 0,
        gameCount: 0,
        streakHolder: null,
        streakLen: 0,
        largestWin: null,
        closestGame: null,
        lastMeeting: null,
      };
      byPair.set(key, acc);
    }

    const aIsHome = m.homeFranchiseId === franchiseA;
    const scoreA = aIsHome ? m.homeScore : m.awayScore;
    const scoreB = aIsHome ? m.awayScore : m.homeScore;
    const margin = Math.abs(scoreA - scoreB);

    acc.pointsA += scoreA;
    acc.pointsB += scoreB;
    acc.marginSum += margin;
    acc.gameCount += 1;
    acc.lastMeeting = { season: m.season, week: m.week };

    let resultForA: "W" | "L" | "T";
    if (m.winner === "tie") resultForA = "T";
    else if ((m.winner === "home" && aIsHome) || (m.winner === "away" && !aIsHome)) resultForA = "W";
    else resultForA = "L";

    const bucketIsPlayoff = m.weekType === "playoff" || m.weekType === "championship";
    if (bucketIsPlayoff) {
      if (resultForA === "W") acc.playoffW += 1;
      else if (resultForA === "L") acc.playoffL += 1;
      else acc.playoffT += 1;
    } else {
      if (resultForA === "W") acc.regularW += 1;
      else if (resultForA === "L") acc.regularL += 1;
      else acc.regularT += 1;
    }

    if (resultForA === "T") {
      acc.streakHolder = null;
      acc.streakLen = 0;
    } else {
      const winnerId = resultForA === "W" ? franchiseA : franchiseB;
      if (acc.streakHolder === winnerId) acc.streakLen += 1;
      else {
        acc.streakHolder = winnerId;
        acc.streakLen = 1;
      }

      if (!acc.largestWin || margin > acc.largestWin.value) {
        acc.largestWin = { winnerFranchiseId: winnerId, value: margin, season: m.season, week: m.week };
      }
    }

    if (!acc.closestGame || margin < acc.closestGame.margin) {
      acc.closestGame = { season: m.season, week: m.week, margin };
    }
  }

  return [...byPair.values()]
    .map((acc) => ({
      franchiseA: acc.franchiseA,
      franchiseB: acc.franchiseB,
      regularW: acc.regularW,
      regularL: acc.regularL,
      regularT: acc.regularT,
      playoffW: acc.playoffW,
      playoffL: acc.playoffL,
      playoffT: acc.playoffT,
      pointsA: acc.pointsA,
      pointsB: acc.pointsB,
      avgMargin: acc.gameCount > 0 ? acc.marginSum / acc.gameCount : 0,
      streakHolder: acc.streakHolder,
      streakLen: acc.streakLen,
      largestWin: acc.largestWin,
      closestGame: acc.closestGame,
      lastMeeting: acc.lastMeeting,
    }))
    .sort((a, b) => a.franchiseA - b.franchiseA || a.franchiseB - b.franchiseB);
}
