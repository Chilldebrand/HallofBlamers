/**
 * Hand-built ESPN-shaped fixtures for a single fictional season (2024, league
 * id 555): 4 teams, 2 regular-season weeks, boxscores, and a draft. Used by
 * `normalize.test.ts` to exercise the whole `normalizeSeason` pipeline.
 *
 * Shape choices here are deliberately checked against REAL archived
 * snapshots (`data/league.db`, read-only) rather than assumed from
 * community docs, after a fix round caught two divergences:
 *   - The season-scope `schedule[]` never has `playoffTierType` on any real
 *     season — only the WEEKLY (`mBoxscore,mMatchupScore,mRoster`) payload's
 *     `schedule[]` does, and that weekly schedule covers the WHOLE season
 *     (every week's entries), not just the week it was fetched for — only
 *     the entries matching that fetch's own week carry roster data.
 *   - `transactions[]` never appears on the SEASON-SCOPE payload in real
 *     data. Task 7's live probe confirmed the real source: a per-period
 *     `view=mTransactions2&scoringPeriodId=N` fetch, strictly per-period,
 *     with its own snapshot lineage (`TRANSACTIONS_VIEW_KEY`). See
 *     `buildTransactionsPeriodPayload` and the `build*Transaction` builders
 *     below for the real transaction/item shapes (confirmed field names,
 *     including the real `TRADE` item type and `WAIVER`'s `PROCESS`
 *     `executionType`).
 *
 * Every `build*` function returns a FRESH object each call (via
 * `structuredClone`) so tests can mutate their own copy without bleeding
 * state into other tests.
 */

export const FIXTURE_SEASON = 2024;
export const FIXTURE_LEAGUE_ID = 555;

export const SWID = {
  team1: "{SWID-0000-0000-0000-000000000001}",
  team2: "{SWID-0000-0000-0000-000000000002}",
  team3: "{SWID-0000-0000-0000-000000000003}",
  team4: "{SWID-0000-0000-0000-000000000004}",
};

/** `matchupPeriodId`, `home`/`away` teamIds+scores, and `winner` — NO `playoffTierType` (real season-scope shape). */
const SEASON_SCOPE_SCHEDULE = [
  { id: 101, matchupPeriodId: 1, home: { teamId: 1, totalPoints: 120.5 }, away: { teamId: 2, totalPoints: 110.2 }, winner: "HOME" },
  { id: 102, matchupPeriodId: 1, home: { teamId: 3, totalPoints: 95.0 }, away: { teamId: 4, totalPoints: 130.0 }, winner: "AWAY" },
  { id: 103, matchupPeriodId: 2, home: { teamId: 1, totalPoints: 90.0 }, away: { teamId: 4, totalPoints: 88.0 }, winner: "HOME" },
  { id: 104, matchupPeriodId: 2, home: { teamId: 2, totalPoints: 102.0 }, away: { teamId: 3, totalPoints: 99.5 }, winner: "HOME" },
];

const SEASON_SCOPE_TEMPLATE = {
  settings: {
    name: "Fixture League",
    size: 4,
    rosterSettings: {
      lineupSlotCounts: {
        "0": 1, // QB
        "2": 2, // RB
        "4": 2, // WR
        "6": 1, // TE
        "23": 1, // FLEX
        "17": 1, // K
        "16": 1, // D/ST
        "20": 6, // BE
        "21": 2, // IR
      },
    },
    scheduleSettings: { matchupPeriodCount: 2 },
    scoringSettings: { scoringItems: [] },
  },
  status: { finalScoringPeriod: 2, currentMatchupPeriod: 2, latestScoringPeriod: 2 },
  members: [
    { id: SWID.team1, displayName: "Manager One", firstName: "One", lastName: "Manager" },
    { id: SWID.team2, displayName: "Manager Two", firstName: "Two", lastName: "Manager" },
    { id: SWID.team3, displayName: "Manager Three", firstName: "Three", lastName: "Manager" },
    { id: SWID.team4, displayName: "Manager Four", firstName: "Four", lastName: "Manager" },
  ],
  teams: [
    {
      id: 1,
      abbrev: "ONE",
      name: "Team One",
      logo: "https://example.com/1.png",
      owners: [SWID.team1],
      record: { overall: { wins: 2, losses: 0, ties: 0, pointsFor: 210.5, pointsAgainst: 198.2 } },
      playoffSeed: 1,
      rankCalculatedFinal: 1,
    },
    {
      id: 2,
      abbrev: "TWO",
      name: "Team Two",
      logo: "https://example.com/2.png",
      owners: [SWID.team2],
      record: { overall: { wins: 0, losses: 2, ties: 0, pointsFor: 212.2, pointsAgainst: 220.0 } },
      playoffSeed: 4,
      rankCalculatedFinal: 4,
    },
    {
      id: 3,
      abbrev: "THR",
      name: "Team Three",
      logo: "https://example.com/3.png",
      owners: [SWID.team3],
      record: { overall: { wins: 1, losses: 1, ties: 0, pointsFor: 204.5, pointsAgainst: 196.0 } },
      playoffSeed: 3,
      rankCalculatedFinal: 3,
    },
    {
      id: 4,
      abbrev: "FOU",
      name: "Team Four",
      logo: "https://example.com/4.png",
      owners: [SWID.team4],
      record: { overall: { wins: 1, losses: 1, ties: 0, pointsFor: 218.0, pointsAgainst: 210.5 } },
      playoffSeed: 2,
      rankCalculatedFinal: 2,
    },
  ],
  schedule: SEASON_SCOPE_SCHEDULE,
  draftDetail: {
    picks: [
      { playerId: 5001, teamId: 1, roundId: 1, roundPickNumber: 1, overallPickNumber: 1, keeper: false },
      { playerId: 5101, teamId: 2, roundId: 1, roundPickNumber: 2, overallPickNumber: 2, keeper: true },
      { playerId: 5201, teamId: 3, roundId: 1, roundPickNumber: 3, overallPickNumber: 3, keeper: false },
      { playerId: 5301, teamId: 4, roundId: 1, roundPickNumber: 4, overallPickNumber: 4, keeper: false, bidAmount: 15 },
    ],
  },
  // Deliberately NO top-level `transactions` — real archived season-scope payloads don't have
  // one either (see file docstring). normalize.ts defaults this to [] defensively either way.
};

/** Full season-scope payload (`mDraftDetail,mMatchup,mSettings,mStandings,mTeam,mTransactions2`). */
export function buildSeasonScopePayload(): Record<string, unknown> {
  return structuredClone(SEASON_SCOPE_TEMPLATE);
}

/**
 * Per-period `view=mTransactions2&scoringPeriodId=N` payload — the REAL
 * shape confirmed by live probe (Task 7): top-level `draftDetail, gameId,
 * id, scoringPeriodId, seasonId, segmentId, status, transactions`. This is
 * a DIFFERENT snapshot lineage from the season-scope payload (which never
 * actually carries transaction data — see `TRANSACTIONS_VIEW_KEY`'s
 * docstring in espn-shapes.ts).
 */
export function buildTransactionsPeriodPayload(period: number, transactions: Record<string, unknown>[]): Record<string, unknown> {
  return {
    draftDetail: { drafted: true },
    gameId: 1,
    id: FIXTURE_LEAGUE_ID,
    scoringPeriodId: period,
    seasonId: FIXTURE_SEASON,
    segmentId: 0,
    status: {},
    transactions,
  };
}

/** Fields common to every real transaction object, confirmed by live probe (Task 7). */
function baseTransaction(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    bidAmount: 0,
    executionType: "EXECUTE",
    isActingAsTeamOwner: false,
    isLeagueManager: false,
    isPending: false,
    proposedDate: 1690000000000,
    rating: 0,
    ...overrides,
  };
}

/** `type=FREEAGENT`, `status=EXECUTED` — a same-day add+drop. Maps to `transactions.type='freeagent'`. */
export function buildFreeAgentTransaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseTransaction({
    id: "tx-freeagent-1",
    type: "FREEAGENT",
    status: "EXECUTED",
    teamId: 1,
    items: [
      { playerId: 6001, type: "ADD", fromTeamId: 0, toTeamId: 1 },
      { playerId: 5004, type: "DROP", fromTeamId: 1, toTeamId: 0 },
    ],
    ...overrides,
  });
}

/** `type=WAIVER`, `status=EXECUTED`, `executionType=PROCESS` (confirmed — differs from EXECUTE). Maps to `'waiver'`. */
export function buildWaiverTransaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseTransaction({
    id: "tx-waiver-1",
    type: "WAIVER",
    status: "EXECUTED",
    executionType: "PROCESS",
    bidAmount: 5,
    processDate: 1690003600000,
    teamId: 2,
    items: [
      { playerId: 6002, type: "ADD", fromTeamId: 0, toTeamId: 2 },
      { playerId: 5102, type: "DROP", fromTeamId: 2, toTeamId: 0 },
    ],
    ...overrides,
  });
}

/**
 * `type=TRADE_ACCEPT`, `status=EXECUTED` — items use the real `TRADE` item
 * type (confirmed by live probe), one item per player carrying BOTH real
 * `fromTeamId`/`toTeamId` (unlike ADD/DROP, never `0`). Maps to `'trade'`.
 */
export function buildTradeTransaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseTransaction({
    id: "tx-trade-1",
    type: "TRADE_ACCEPT",
    status: "EXECUTED",
    teamId: 2,
    items: [
      { playerId: 5101, type: "TRADE", fromTeamId: 2, toTeamId: 3 },
      { playerId: 5201, type: "TRADE", fromTeamId: 3, toTeamId: 2 },
    ],
    ...overrides,
  });
}

/** `type=TRADE_PROPOSAL`, `status=PENDING` — never executed. Must be skipped, not mapped. */
export function buildUnexecutedTradeProposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseTransaction({
    id: "tx-proposal-1",
    type: "TRADE_PROPOSAL",
    status: "PENDING",
    teamId: 1,
    items: [{ playerId: 5101, type: "TRADE", fromTeamId: 2, toTeamId: 1 }],
    ...overrides,
  });
}

/** `type=DRAFT` — always skipped, already captured via `draftDetail.picks` -> `draft_picks`. */
export function buildDraftTypeTransaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseTransaction({
    id: "tx-draft-1",
    type: "DRAFT",
    status: "EXECUTED",
    teamId: 1,
    items: [{ playerId: 5001, type: "DRAFT", fromTeamId: 0, toTeamId: 1, overallPickNumber: 1 }],
    ...overrides,
  });
}

/** `type=FUTURE_ROSTER` — always skipped (pure lineup management; real examples are LINEUP-only items). */
export function buildFutureRosterTransaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseTransaction({
    id: "tx-futureroster-1",
    type: "FUTURE_ROSTER",
    status: "EXECUTED",
    teamId: 1,
    items: [{ playerId: 5001, type: "LINEUP", fromLineupSlotId: 20, toLineupSlotId: 0, fromTeamId: 0, toTeamId: 0 }],
    ...overrides,
  });
}

/** `type=ROSTER` with a DROP item ("ROSTER-with-adds-drops" per the brief) — maps to `'drop'`. */
export function buildRosterDropTransaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseTransaction({
    id: "tx-roster-1",
    type: "ROSTER",
    status: "EXECUTED",
    teamId: 4,
    items: [{ playerId: 5301, type: "DROP", fromTeamId: 4, toTeamId: 0 }],
    ...overrides,
  });
}

/**
 * A `leagueHistory`-style array-wrapped payload — confirmed against real
 * archived 2015-2017 snapshots that this is exactly how ESPN returns
 * pre-modern seasons: `[ { seasonId, settings, status, teams, schedule,
 * ... } ]`, length 1. Wraps the same fixture league data as
 * `buildSeasonScopePayload`, tagged with `season`, plus a decoy entry for a
 * different season to exercise the `seasonId`-preferring unwrap logic.
 */
export function buildLeagueHistoryWrappedPayload(season = FIXTURE_SEASON): unknown[] {
  const entry = buildSeasonScopePayload() as Record<string, unknown>;
  entry.seasonId = season;
  entry.id = FIXTURE_LEAGUE_ID;
  const decoy = { ...structuredClone(SEASON_SCOPE_TEMPLATE), seasonId: season - 1, id: FIXTURE_LEAGUE_ID };
  return [decoy, entry];
}

interface PlayerFixture {
  id: number;
  fullName: string;
  defaultPositionId: number;
  proTeamId: number;
  eligibleSlots: number[];
  lineupSlotId: number;
  appliedStatTotal: number;
  projectedPoints?: number;
}

function playerPoolEntry(week: number, p: PlayerFixture) {
  return {
    lineupSlotId: p.lineupSlotId,
    playerPoolEntry: {
      id: p.id,
      appliedStatTotal: p.appliedStatTotal,
      player: {
        id: p.id,
        fullName: p.fullName,
        defaultPositionId: p.defaultPositionId,
        proTeamId: p.proTeamId,
        eligibleSlots: p.eligibleSlots,
        stats:
          p.projectedPoints !== undefined
            ? [
                { scoringPeriodId: week, statSourceId: 0, appliedTotal: p.appliedStatTotal },
                { scoringPeriodId: week, statSourceId: 1, appliedTotal: p.projectedPoints },
              ]
            : [{ scoringPeriodId: week, statSourceId: 0, appliedTotal: p.appliedStatTotal }],
      },
    },
  };
}

const WEEK1_ROSTERS: Record<number, PlayerFixture[]> = {
  1: [
    {
      id: 5001,
      fullName: "Star QB",
      defaultPositionId: 1,
      proTeamId: 9,
      eligibleSlots: [0, 7],
      lineupSlotId: 0,
      appliedStatTotal: 25.5,
      projectedPoints: 22.0,
    },
    {
      id: 5002,
      fullName: "Star RB",
      defaultPositionId: 2,
      proTeamId: 10,
      eligibleSlots: [2, 3, 23],
      lineupSlotId: 2,
      appliedStatTotal: 18.0,
      projectedPoints: 15.0,
    },
    {
      id: 5003,
      fullName: "Flex WR",
      defaultPositionId: 3,
      proTeamId: 19,
      eligibleSlots: [4, 5, 23],
      lineupSlotId: 23,
      appliedStatTotal: 12.0,
    },
    {
      id: 5004,
      fullName: "Bench TE",
      defaultPositionId: 4,
      proTeamId: 18,
      eligibleSlots: [6, 5, 23],
      lineupSlotId: 20,
      appliedStatTotal: 5.0,
    },
    {
      id: 5005,
      fullName: "IR RB",
      defaultPositionId: 2,
      proTeamId: 6,
      eligibleSlots: [2, 3, 23],
      lineupSlotId: 21,
      appliedStatTotal: 0,
    },
  ],
  2: [
    {
      id: 5101,
      fullName: "Team Two QB",
      defaultPositionId: 1,
      proTeamId: 17,
      eligibleSlots: [0, 7],
      lineupSlotId: 0,
      appliedStatTotal: 15.0,
    },
    {
      id: 5102,
      fullName: "Team Two Bench",
      defaultPositionId: 2,
      proTeamId: 1,
      eligibleSlots: [2, 3, 23],
      lineupSlotId: 20,
      appliedStatTotal: 3.0,
    },
  ],
  3: [
    {
      id: 5201,
      fullName: "Team Three TE",
      defaultPositionId: 4,
      proTeamId: 8,
      eligibleSlots: [6, 5, 23],
      lineupSlotId: 6,
      appliedStatTotal: 10.0,
    },
  ],
  4: [
    {
      id: 5301,
      fullName: "Team Four Kicker",
      defaultPositionId: 5,
      proTeamId: 25,
      eligibleSlots: [17],
      lineupSlotId: 17,
      appliedStatTotal: 8.0,
    },
  ],
};

const WEEK2_ROSTERS: Record<number, PlayerFixture[]> = {
  1: [{ ...WEEK1_ROSTERS[1]![0]!, appliedStatTotal: 20.0, projectedPoints: 19.0 }],
  2: [{ ...WEEK1_ROSTERS[2]![0]!, appliedStatTotal: 14.0 }],
  3: [{ ...WEEK1_ROSTERS[3]![0]!, appliedStatTotal: 9.0 }],
  4: [{ ...WEEK1_ROSTERS[4]![0]!, appliedStatTotal: 7.0 }],
};

const ROSTERS_BY_WEEK: Record<1 | 2, Record<number, PlayerFixture[]>> = { 1: WEEK1_ROSTERS, 2: WEEK2_ROSTERS };

/**
 * Weekly (`mBoxscore,mMatchupScore,mRoster`) payload for `week` (1 or 2).
 * Matches the real shape confirmed against archived data: `schedule[]`
 * covers the WHOLE season (all 4 fixture matchups, every one carrying
 * `playoffTierType`), but `rosterForCurrentScoringPeriod` is only populated
 * on the entries belonging to `week` — every other entry's side has just
 * `teamId`, exactly like a real weekly snapshot fetched for a different
 * period than the one being inspected.
 */
export function buildWeekScopePayload(week: 1 | 2): Record<string, unknown> {
  const rosters = ROSTERS_BY_WEEK[week];

  return {
    schedule: SEASON_SCOPE_SCHEDULE.map((entry) => {
      const isThisWeek = entry.matchupPeriodId === week;
      const side = (teamId: number) =>
        isThisWeek
          ? { teamId, rosterForCurrentScoringPeriod: { entries: (rosters[teamId] ?? []).map((p) => playerPoolEntry(week, p)) } }
          : { teamId };
      return {
        id: entry.id,
        matchupPeriodId: entry.matchupPeriodId,
        home: side(entry.home.teamId),
        away: side(entry.away.teamId),
        winner: entry.winner,
        playoffTierType: "NONE", // this fixture models an all-regular-season 2-week schedule
      };
    }),
  };
}

/** Franchise seed mapping all 4 fixture teams: teams 1/2 via explicit espnTeamIds, 3/4 via ownerSwid fallback. */
export function buildFranchiseSeed() {
  return {
    franchises: [
      {
        id: 1,
        canonicalName: "Franchise One",
        managerName: "Manager One",
        joinedSeason: FIXTURE_SEASON,
        departedSeason: null,
        active: true,
        accentColor: null,
        notes: null,
        managers: [{ managerName: "Manager One", espnOwnerSwid: SWID.team1, fromSeason: FIXTURE_SEASON, toSeason: null }],
        espnTeamIds: [{ season: FIXTURE_SEASON, espnTeamId: 1 }],
      },
      {
        id: 2,
        canonicalName: "Franchise Two",
        managerName: "Manager Two",
        joinedSeason: FIXTURE_SEASON,
        departedSeason: null,
        active: true,
        accentColor: null,
        notes: null,
        managers: [{ managerName: "Manager Two", espnOwnerSwid: SWID.team2, fromSeason: FIXTURE_SEASON, toSeason: null }],
        espnTeamIds: [{ season: FIXTURE_SEASON, espnTeamId: 2 }],
      },
      {
        id: 3,
        canonicalName: "Franchise Three",
        managerName: "Manager Three",
        joinedSeason: FIXTURE_SEASON,
        departedSeason: null,
        active: true,
        accentColor: null,
        notes: null,
        managers: [{ managerName: "Manager Three", espnOwnerSwid: SWID.team3, fromSeason: FIXTURE_SEASON, toSeason: null }],
        espnTeamIds: [], // resolved via ownerSwid fallback, not an explicit mapping
      },
      {
        id: 4,
        canonicalName: "Franchise Four",
        managerName: "Manager Four",
        joinedSeason: FIXTURE_SEASON,
        departedSeason: null,
        active: true,
        accentColor: null,
        notes: null,
        managers: [{ managerName: "Manager Four", espnOwnerSwid: SWID.team4, fromSeason: FIXTURE_SEASON, toSeason: null }],
        espnTeamIds: [], // resolved via ownerSwid fallback, not an explicit mapping
      },
    ],
  };
}
