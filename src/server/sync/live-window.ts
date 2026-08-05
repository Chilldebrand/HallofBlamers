/**
 * Live-tier game-window rules (Task 25) — replaces `worker/index.ts`'s old `LIVE_TIER_SCHEDULE`
 * stub. Two independent gates decide whether a given tick should actually run the live sync tier:
 *
 *   1. `isWithinLiveWindow(now)` — a PURE, wall-clock-only check: is `now` inside one of the named
 *      game windows below, in the league's home timezone? This is deliberately data-independent
 *      (no DB access) so it's trivially unit-testable and has zero runtime cost.
 *   2. `hasScheduledNonFinalMatchup` (see `run-tier.ts`) — a DB check: does the CURRENT season
 *      actually have a non-final matchup at all? `isWithinLiveWindow` alone can't tell "Sunday
 *      1pm in July" (no season in progress) from "Sunday 1pm in November" (games happening) — it
 *      only knows day-of-week and time-of-day, which repeat year-round regardless of the NFL
 *      calendar. Deriving "is there a live season" from the DB (rather than hardcoding week
 *      numbers or month ranges) is what the brief's "derive from data, not hardcoded week
 *      numbers" instruction means.
 *
 * Both gates must pass for the live tier to actually fetch anything on a given tick.
 */

/** All window boundaries are evaluated in the league's home timezone. */
export const LIVE_WINDOW_TIMEZONE = "America/New_York";

/** How often the live tier should poll while inside a window (croner registers separate jobs per
 * window in `worker/index.ts`, each on this cadence). */
export const LIVE_TIER_INTERVAL_SECONDS = 120;

export interface LiveWindowRule {
  label: string;
  /** 0 = Sunday, ..., 6 = Saturday (JS `Date#getDay`/`Intl` weekday convention). */
  dayOfWeek: number;
  /** Inclusive, minutes since local midnight. */
  startMinuteOfDay: number;
  /** Inclusive, minutes since local midnight — 1439 = 23:59. */
  endMinuteOfDay: number;
}

const END_OF_DAY_MINUTE = 23 * 60 + 59; // 23:59

/**
 * The three named game windows (America/New_York), per the brief:
 *   - Thursday Night Football: 20:00-23:59
 *   - Sunday: 12:55-23:59 (starts 5 minutes early to be warmed up before the 1:00pm kickoff wave)
 *   - Monday Night Football: 20:00-23:59
 * Deliberately NOT gated by week number or calendar month here — see the module docstring's gate
 * 2 (`hasScheduledNonFinalMatchup`) for how the offseason is excluded instead.
 */
export const LIVE_WINDOWS: readonly LiveWindowRule[] = [
  { label: "Thursday Night Football", dayOfWeek: 4, startMinuteOfDay: 20 * 60, endMinuteOfDay: END_OF_DAY_MINUTE },
  { label: "Sunday", dayOfWeek: 0, startMinuteOfDay: 12 * 60 + 55, endMinuteOfDay: END_OF_DAY_MINUTE },
  { label: "Monday Night Football", dayOfWeek: 1, startMinuteOfDay: 20 * 60, endMinuteOfDay: END_OF_DAY_MINUTE },
] as const;

/** `now`'s (dayOfWeek, minuteOfDay) in `LIVE_WINDOW_TIMEZONE`, via `Intl` rather than manual UTC
 * offset math — correctly handles America/New_York's DST transitions with no lookup table. */
function localDayAndMinute(now: Date): { dayOfWeek: number; minuteOfDay: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: LIVE_WINDOW_TIMEZONE,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);

  const weekdayShort = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");

  const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = WEEKDAY_INDEX[weekdayShort] ?? 0;

  return { dayOfWeek, minuteOfDay: hour * 60 + minute };
}

/** True iff `now` falls inside ANY of `LIVE_WINDOWS`, evaluated in `LIVE_WINDOW_TIMEZONE`. Pure —
 * no DB access, no season/week awareness (see module docstring's gate 2 for that half). */
export function isWithinLiveWindow(now: Date): boolean {
  const { dayOfWeek, minuteOfDay } = localDayAndMinute(now);
  return LIVE_WINDOWS.some(
    (w) => w.dayOfWeek === dayOfWeek && minuteOfDay >= w.startMinuteOfDay && minuteOfDay <= w.endMinuteOfDay,
  );
}
