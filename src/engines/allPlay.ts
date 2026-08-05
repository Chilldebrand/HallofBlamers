/**
 * All-play: each team's record against every OTHER team's score that same
 * week, not just their actual scheduled opponent. Pure per AGENTS.md.
 */

export interface AllPlayScoreInput {
  franchiseId: number;
  score: number;
}

export interface AllPlayResult {
  franchiseId: number;
  wins: number;
  losses: number;
  ties: number;
}

/** One result per input team, in input order. A lone team plays nobody: 0/0/0. */
export function allPlayWeek(scores: AllPlayScoreInput[]): AllPlayResult[] {
  return scores.map((team, i) => {
    let wins = 0;
    let losses = 0;
    let ties = 0;

    for (let j = 0; j < scores.length; j++) {
      if (i === j) continue;
      const other = scores[j]!;
      if (team.score > other.score) wins++;
      else if (team.score < other.score) losses++;
      else ties++;
    }

    return { franchiseId: team.franchiseId, wins, losses, ties };
  });
}
