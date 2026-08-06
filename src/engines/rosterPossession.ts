export type AcquisitionType = "waiver" | "freeagent" | "trade";

export interface AcquireEvent {
  kind: "acquire";
  teamSeasonId: number;
  playerId: number;
  week: number;
  acquisitionType: AcquisitionType;
  transactionId: number;
  espnTxId: string;
}

export interface DepartEvent {
  kind: "depart";
  teamSeasonId: number;
  playerId: number;
  week: number;
}

export type RosterMoveEvent = AcquireEvent | DepartEvent;

export interface RosterPointRow {
  teamSeasonId: number;
  playerId: number;
  week: number;
  isStarter: boolean;
  points: number | null;
}

export interface PossessionWindow {
  teamSeasonId: number;
  playerId: number;
  acquisitionType: AcquisitionType;
  transactionId: number;
  espnTxId: string;
  startWeek: number;
  endWeekExclusive: number | null;
  stillRostered: boolean;
  weeksRostered: number;
  startsMade: number;
  starterPoints: number;
}

function sortEvents(events: RosterMoveEvent[]): RosterMoveEvent[] {
  return [...events].sort((a, b) => {
    if (a.week !== b.week) return a.week - b.week;
    if (a.kind !== b.kind) return a.kind === "depart" ? -1 : 1;
    if (a.kind === "acquire" && b.kind === "acquire") return a.transactionId - b.transactionId;
    return 0;
  });
}

function aggregateWindow(
  base: Omit<PossessionWindow, "weeksRostered" | "startsMade" | "starterPoints" | "stillRostered">,
  rosterRows: RosterPointRow[],
): PossessionWindow {
  const inRange = rosterRows.filter(
    (r) =>
      r.teamSeasonId === base.teamSeasonId &&
      r.playerId === base.playerId &&
      r.week >= base.startWeek &&
      (base.endWeekExclusive === null || r.week < base.endWeekExclusive),
  );
  const starterRows = inRange.filter((r) => r.isStarter);
  const starterPoints = starterRows.reduce((sum, r) => sum + (r.points ?? 0), 0);

  return {
    ...base,
    stillRostered: base.endWeekExclusive === null,
    weeksRostered: inRange.length,
    startsMade: starterRows.length,
    starterPoints,
  };
}

export function computePossessionWindows(events: RosterMoveEvent[], rosterRows: RosterPointRow[]): PossessionWindow[] {
  const byPair = new Map<string, RosterMoveEvent[]>();
  for (const e of events) {
    const key = `${e.teamSeasonId}:${e.playerId}`;
    const list = byPair.get(key);
    if (list) list.push(e);
    else byPair.set(key, [e]);
  }

  const windows: PossessionWindow[] = [];

  for (const list of byPair.values()) {
    const sorted = sortEvents(list);
    let open: AcquireEvent | null = null;

    for (const event of sorted) {
      if (event.kind === "acquire") {
        if (open) continue;
        open = event;
      } else {
        if (!open) continue; // depart with nothing open â€” not an acquisition this engine tracks
        windows.push(
          aggregateWindow(
            {
              teamSeasonId: open.teamSeasonId,
              playerId: open.playerId,
              acquisitionType: open.acquisitionType,
              transactionId: open.transactionId,
              espnTxId: open.espnTxId,
              startWeek: open.week,
              endWeekExclusive: event.week,
            },
            rosterRows,
          ),
        );
        open = null;
      }
    }

    if (open) {
      windows.push(
        aggregateWindow(
          {
            teamSeasonId: open.teamSeasonId,
            playerId: open.playerId,
            acquisitionType: open.acquisitionType,
            transactionId: open.transactionId,
            espnTxId: open.espnTxId,
            startWeek: open.week,
            endWeekExclusive: null,
          },
          rosterRows,
        ),
      );
    }
  }

  return windows.sort(
    (a, b) =>
      a.teamSeasonId - b.teamSeasonId ||
      a.playerId - b.playerId ||
      a.startWeek - b.startWeek ||
      a.transactionId - b.transactionId,
  );
}

export const buildRosterPossession = computePossessionWindows;
