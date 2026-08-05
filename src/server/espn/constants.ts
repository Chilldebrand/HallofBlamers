/**
 * ESPN Fantasy Football ID → name maps.
 *
 * LINEUP_SLOT_MAP and PRO_TEAM_MAP are transcribed verbatim from the
 * community-maintained reference implementation's `POSITION_MAP` and
 * `PRO_TEAM_MAP`:
 *   https://raw.githubusercontent.com/cwendt94/espn-api/master/espn_api/football/constant.py
 * (checked 2026-08-03). That file's `POSITION_MAP` is keyed by the same id
 * space ESPN uses for `lineupSlotId` / `eligibleSlots`, so it is transcribed
 * here as our `LINEUP_SLOT_MAP` (the more accurate name for what it models).
 *
 * POSITION_MAP below (keyed by `defaultPositionId`, a player's natural
 * position — a DIFFERENT id space than lineupSlotId) has no equivalent table
 * in that source file: cwendt94/espn-api's football module never maps
 * defaultPositionId through a label lookup (see `player.py` / `box_player.py`,
 * which only use it as an opaque key into external positional-ranking data).
 * Its values below come directly from the task brief's specification instead.
 *
 * One deliberate divergence from the literal source strings: LINEUP_SLOT_MAP[23]
 * is labeled "FLEX" here rather than the source's literal `'RB/WR/TE'`, since
 * "FLEX" is the label the task brief specifies (`23 FLEX (RB/WR/TE)`) and the
 * one downstream code will actually look up; the source's literal string is
 * kept as an inline comment on that entry.
 */

/** ESPN `lineupSlotId` → label. Covers offensive, bench/IR, flex, and IDP slots. */
export const LINEUP_SLOT_MAP: Record<number, string> = {
  0: "QB",
  1: "TQB",
  2: "RB",
  3: "RB/WR",
  4: "WR",
  5: "WR/TE",
  6: "TE",
  7: "OP", // superflex
  8: "DT",
  9: "DE",
  10: "LB",
  11: "DL",
  12: "CB",
  13: "S",
  14: "DB",
  15: "DP",
  16: "D/ST",
  17: "K",
  18: "P",
  19: "HC",
  20: "BE", // bench
  21: "IR",
  22: "",
  23: "FLEX", // RB/WR/TE
  24: "ER",
  25: "Rookie",
};

/**
 * ESPN `defaultPositionId` (a player's natural/default position) → label.
 * NOTE: not sourced from cwendt94/espn-api (see file header) — taken from the
 * task brief's minimum spec. Verify against a live payload before relying on
 * entries beyond these six if IDP support is ever added.
 */
export const POSITION_MAP: Record<number, string> = {
  1: "QB",
  2: "RB",
  3: "WR",
  4: "TE",
  5: "K",
  16: "D/ST",
};

/** ESPN `proTeamId` → team abbreviation. 0 = free agent / no pro team. */
export const PRO_TEAM_MAP: Record<number, string> = {
  0: "None",
  1: "ATL",
  2: "BUF",
  3: "CHI",
  4: "CIN",
  5: "CLE",
  6: "DAL",
  7: "DEN",
  8: "DET",
  9: "GB",
  10: "TEN",
  11: "IND",
  12: "KC",
  13: "LV",
  14: "LAR",
  15: "MIA",
  16: "MIN",
  17: "NE",
  18: "NO",
  19: "NYG",
  20: "NYJ",
  21: "PHI",
  22: "ARI",
  23: "PIT",
  24: "LAC",
  25: "SF",
  26: "SEA",
  27: "TB",
  28: "WSH",
  29: "CAR",
  30: "JAX",
  // Note: 31 and 32 are not assigned in the source map (historical gap).
  33: "BAL",
  34: "HOU",
};

/** Builds a label → id reverse lookup, skipping empty-string labels. */
function invert(map: Record<number, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, label] of Object.entries(map)) {
    if (label) out[label] = Number(id);
  }
  return out;
}

export const LINEUP_SLOT_NAME_TO_ID: Record<string, number> = invert(LINEUP_SLOT_MAP);
export const POSITION_NAME_TO_ID: Record<string, number> = invert(POSITION_MAP);
export const PRO_TEAM_ABBREV_TO_ID: Record<string, number> = invert(PRO_TEAM_MAP);
