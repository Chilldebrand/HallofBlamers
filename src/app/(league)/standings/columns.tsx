import { cn } from "@/components/ui/cn";

/**
 * Column header copy — labels AND their mouseover explanations — for the Standings page (Task
 * 29: "add a mouseover explanation of each column to its header"). Native `title` attributes
 * only, no client JS/tooltip library, per the page's dynamic-SSR-only rule. One source of truth
 * per stat so the same column's tooltip text can't drift between its desktop and phone-collapsed
 * appearances, or between the Real and Luck tabs' shared "Franchise" column.
 *
 * The Gap tooltip's sign language ("positive = the schedule flattered you") MUST match
 * `scheduleHelp()`'s pinned convention in `src/server/queries/standings.ts` — that function's
 * docstring is the actual source of truth; this copy restates it for the reader, not the other
 * way around. If that convention ever changes, this file has to change with it.
 *
 * Fix round 1 (user-directed revision, pending final sign-off): the Luck tooltip was rewritten
 * because the first version read as "score vs. expected score" rather than "result vs. all-play
 * result", and it omitted the ±0.25 close-game kicker entirely — `weeklyLuck()` in
 * src/engines/luck.ts is `(result - pAllPlay) + 0.25 * closeSwing`, and the tooltip now names
 * both terms so the formula can't quietly drift from the copy again. If `weeklyLuck()`'s formula
 * changes, this tooltip has to change with it too.
 */
export interface ColumnHeader {
  label: string;
  title: string;
}

const COLUMNS = {
  rank: { label: "#", title: "Rank — final standing once the season's decided; win percentage then points for while it's still in progress." },
  rankCareer: { label: "#", title: "Rank by all-time win percentage." },
  franchise: { label: "Franchise", title: "The franchise, not the manager — this is what every stat on this site actually tracks." },
  wlt: { label: "W-L-T", title: "Wins-losses-ties this season." },
  wltCareer: { label: "W-L-T", title: "All-time wins-losses-ties." },
  winPct: { label: "Win %", title: "All-time win percentage, ties counted as half a win." },
  pf: { label: "PF", title: "Points scored this season." },
  pfCareer: { label: "PF", title: "Points scored, all-time." },
  pa: { label: "PA", title: "Points allowed this season." },
  paCareer: { label: "PA", title: "Points allowed, all-time." },
  last5: { label: "Last 5", title: "Result of the last five games played, oldest to newest, left to right." },
  streak: { label: "Streak", title: "Current run of wins or losses in a row — a tie breaks the streak." },
  seasons: { label: "Seasons", title: "Seasons played — a season only counts once it's actually played a game, so an empty preseason doesn't inflate anyone's count." },
  champs: { label: "Champs", title: "Championships won." },
  sackos: { label: "Sackos", title: "Times finishing dead last. Everyone remembers." },
  luck: {
    label: "Luck",
    title:
      "The wins you got versus the wins your scores deserved. Each week, all-play grades your score against the whole league — that's the win you 'deserved' — and luck is the gap between that and what actually happened, plus a ±0.25 kicker for squeakers decided by 5 or fewer. Positive = the schedule's been gifting you.",
  },
  closeGames: { label: "Close Games", title: "Games decided by 5 points or fewer." },
  realPct: { label: "Real %", title: "Actual win percentage from the real schedule." },
  allPlay: { label: "All-Play", title: "Your record if you played every team every week, not just your actual schedule." },
  allPlayPct: { label: "All-Play %", title: "All-play wins divided by all-play games played, as a percentage." },
  gap: {
    label: "Gap",
    title: "Real win % minus all-play win %. Positive = the schedule flattered you. Negative = it didn't, and you've already told everyone about it.",
  },
} as const satisfies Record<string, ColumnHeader>;

export const REAL_SEASON_HEADERS: ColumnHeader[] = [COLUMNS.rank, COLUMNS.franchise, COLUMNS.wlt, COLUMNS.pf, COLUMNS.pa, COLUMNS.last5, COLUMNS.streak];
export const REAL_SEASON_HEADERS_PHONE: ColumnHeader[] = [COLUMNS.rank, COLUMNS.franchise, COLUMNS.wlt, COLUMNS.pf];

// No phone-collapsed variant: the Real Career table stays one grid at every width (horizontal
// scroll, same convention the pre-merge Luck/All-Play tabs used) — Task 29's phone-collapse
// extension was scoped to "the merged table" (Luck) specifically, not this new career table.
export const REAL_CAREER_HEADERS: ColumnHeader[] = [
  COLUMNS.rankCareer,
  COLUMNS.franchise,
  COLUMNS.wltCareer,
  COLUMNS.winPct,
  COLUMNS.pfCareer,
  COLUMNS.paCareer,
  COLUMNS.seasons,
  COLUMNS.champs,
  COLUMNS.sackos,
];

export const LUCK_HEADERS: ColumnHeader[] = [
  COLUMNS.franchise,
  COLUMNS.luck,
  COLUMNS.closeGames,
  COLUMNS.realPct,
  COLUMNS.allPlay,
  COLUMNS.allPlayPct,
  COLUMNS.gap,
];
export const LUCK_HEADERS_PHONE: ColumnHeader[] = [COLUMNS.franchise, COLUMNS.luck, COLUMNS.allPlay, COLUMNS.gap];

/**
 * Shared column-header row — every header carries its explanation in `data-tip`, rendered by the
 * pure-CSS `.tip` bubble in globals.css (instant on hover, tap/focus-friendly via tabIndex, dotted
 * underline as the affordance — native `title` was invisible in practice, user-reported).
 * `leftAlignCount` is how many leading columns stay left-aligned (Real's `#`+`Franchise` = 2,
 * Luck's `Franchise`-only = 1); the rest right-align and get `.tip-end` so bubbles never overflow
 * the viewport's right edge.
 */
export function HeaderRow({
  columns,
  gridCols,
  leftAlignCount = 1,
  density = "desktop",
}: {
  columns: ColumnHeader[];
  gridCols: string;
  leftAlignCount?: number;
  density?: "desktop" | "phone";
}) {
  return (
    <div role="row" className={cn("grid border-b-2 border-ink", density === "desktop" ? "pb-2.5" : "pb-2", gridCols)}>
      {columns.map((c, i) => (
        <span
          key={c.label}
          role="columnheader"
          data-tip={c.title}
          tabIndex={0}
          className={cn(
            "display tip tracking-[0.16em] text-muted",
            density === "desktop" ? "text-[12px]" : "text-[11px] tracking-[0.14em]",
            i >= leftAlignCount ? "tip-end text-right" : "",
          )}
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}
