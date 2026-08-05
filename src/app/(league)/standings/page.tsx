import type { ReactNode } from "react";
import Link from "next/link";
import { ChampionBadge } from "@/components/league/ChampionBadge";
import { FranchiseName, type FranchiseNameFlags } from "@/components/league/FranchiseName";
import { cn } from "@/components/ui/cn";
import { formatPct, formatSigned, formatWholeCommas, formatWLT } from "@/components/history/format";
import { getDb } from "@/server/db/client";
import { requireManager } from "@/server/auth/guard";
import { getIdentityFlags, resolveFranchiseFlags, type IdentityFlags } from "@/server/queries/identity";
import {
  getDefaultStandingsSeason,
  getSeasonOptions,
  getStandingsCareerSummary,
  getStandingsLuck,
  getStandingsLuckCareer,
  getStandingsReal,
  getStandingsRealCareer,
  getStandingsSeasonSummary,
  resolveStandingsScope,
  resolveStandingsTab,
  type StandingsLuckRow,
  type StandingsRealCareerRow,
  type StandingsRealRow,
  type StandingsScope,
  type StandingsTab,
  type Streak,
} from "@/server/queries/standings";
import {
  HeaderRow,
  LUCK_HEADERS,
  LUCK_HEADERS_PHONE,
  REAL_CAREER_HEADERS,
  REAL_SEASON_HEADERS,
  REAL_SEASON_HEADERS_PHONE,
} from "./columns";

const TABS: { key: StandingsTab; label: string }[] = [
  { key: "real", label: "Real" },
  { key: "luck", label: "Luck" },
];

function hrefFor(scope: StandingsScope, tab: StandingsTab): string {
  return `/standings?season=${scope}&tab=${tab}`;
}

export default async function StandingsPage({ searchParams }: { searchParams: Promise<{ season?: string; tab?: string }> }) {
  const params = await searchParams;
  const manager = await requireManager();
  const identityFlags = getIdentityFlags(getDb(), manager.id);

  const seasonOptions = getSeasonOptions();
  if (seasonOptions.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <Header eyebrow="League" title="Standings" right={null} />
        <p className="text-sm text-muted">No seasons on record yet.</p>
      </div>
    );
  }

  const defaultSeason = getDefaultStandingsSeason() ?? seasonOptions[0]!.season;
  const scope = resolveStandingsScope(params.season, seasonOptions, defaultSeason);
  const tab = resolveStandingsTab(params.tab);

  const seasonStatus = scope === "career" ? undefined : (seasonOptions.find((s) => s.season === scope)?.status ?? "upcoming");
  const summary = scope === "career" ? null : getStandingsSeasonSummary(scope);
  const careerSummary = scope === "career" ? getStandingsCareerSummary() : null;

  return (
    <div className="flex flex-col gap-0">
      <Header
        eyebrow="League"
        title="Standings"
        right={
          scope === "career" ? (
            careerSummary ? (
              <span className="text-[15px] text-muted">
                Career · {careerSummary.seasonCount} season{careerSummary.seasonCount === 1 ? "" : "s"} · {careerSummary.franchiseCount} franchise
                {careerSummary.franchiseCount === 1 ? "" : "s"}
              </span>
            ) : null
          ) : summary ? (
            <span className="text-[15px] text-muted">
              {scope} · {summary.status} · {summary.weekCount} week{summary.weekCount === 1 ? "" : "s"} · {summary.teamCount} franchises
            </span>
          ) : null
        }
      />

      <SeasonPills scope={scope} tab={tab} seasonOptions={seasonOptions} />
      <TabRow scope={scope} tab={tab} />

      <div className="mt-[26px]">
        {tab === "real" ? <RealTab scope={scope} seasonStatus={seasonStatus} identityFlags={identityFlags} /> : null}
        {tab === "luck" ? <LuckTab scope={scope} identityFlags={identityFlags} /> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header block (README, Standings: eyebrow "League", 64px title, right-aligned
// season summary) — hand-rolled rather than the shared PageHeader, which is
// used by ~25 not-yet-restyled pages (including Home, owned by the parallel
// Home slice) and still renders the OLD text-3xl/4xl title; bumping it here
// would visually half-restyle every page that imports it. Season
// pills/tabs below stay URL-param driven exactly as before.
// ---------------------------------------------------------------------------

function Header({ eyebrow, title, right }: { eyebrow: string; title: string; right: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-8 border-b-2 border-ink pb-[18px]">
      <div>
        <div className="display text-[12px] tracking-[0.26em] text-kelly">{eyebrow}</div>
        <h1 className="display mt-1.5 text-page-title tracking-normal text-kelly-deep">{title}</h1>
      </div>
      {right ? <div className="pb-1.5">{right}</div> : null}
    </div>
  );
}

function pillClass(active: boolean): string {
  return cn(
    "display rounded-full border px-3.5 py-1.5 text-[13px] tracking-[0.1em]",
    active ? "border-kelly-deep bg-kelly-deep font-bold text-sheet" : "border-line-sheet-strong text-muted hover:text-ink",
  );
}

function SeasonPills({ scope, tab, seasonOptions }: { scope: StandingsScope; tab: StandingsTab; seasonOptions: { season: number }[] }) {
  return (
    <div className="mt-[22px] flex flex-wrap items-center gap-2">
      {seasonOptions.map((s) => (
        <Link key={s.season} href={hrefFor(s.season, tab)} className={pillClass(s.season === scope)}>
          {s.season}
        </Link>
      ))}
      {/* Task 29 — Career scope, alongside the season pills (not a third tab: it applies to
          whichever tab is open). Separated by a hairline rather than just spacing, since it's a
          different KIND of pill (an aggregation mode, not a year) from everything to its left. */}
      <span aria-hidden="true" className="mx-1 h-4 w-px bg-line-sheet-strong" />
      <Link href={hrefFor("career", tab)} className={pillClass(scope === "career")}>
        Career
      </Link>
    </div>
  );
}

function TabRow({ scope, tab }: { scope: StandingsScope; tab: StandingsTab }) {
  return (
    <div className="mt-[26px] flex gap-0.5 border-b border-line-sheet-strong">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={hrefFor(scope, t.key)}
          className={cn(
            "display border-b-2 px-4 py-2.5 text-nav-item tracking-nav-item",
            t.key === tab ? "border-ink font-bold text-ink" : "border-transparent text-muted hover:text-ink",
          )}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row shell — champion gold-rule/raised (dark: gradient fill), your kelly rule
// + fill, sacko tarnish rule with NO fill, negative-margin trick so the rule
// sits outside the content column. One precedence rule not spelled out in the
// README: a row can only wear ONE fill/rule (champion > you > sacko) — the
// belt mark and YOU tag still stack independently via FranchiseName itself.
// ---------------------------------------------------------------------------

const CHAMPION_DARK_GRADIENT = "dark:bg-[linear-gradient(90deg,var(--color-sheet-raised)_0%,var(--color-sheet-raised)_40%,transparent_100%)]";

function rowShellClass(flags: FranchiseNameFlags, viewport: "desktop" | "phone"): string {
  const neg = viewport === "desktop" ? "-ml-[15px] pl-3" : "-ml-3 pl-[9px]";
  if (flags.isChampion) return cn("border-l-[3px] border-gold-fill bg-sheet-raised", CHAMPION_DARK_GRADIENT, neg);
  if (flags.isViewer) return cn("border-l-[3px] border-kelly bg-viewer-fill", neg);
  if (flags.isSacko) return cn("border-l-[3px] border-tarnish-fill", neg);
  return "";
}

function StandingsGridRow({ gridCols, flags, children }: { gridCols: string; flags: FranchiseNameFlags; children: ReactNode }) {
  return (
    <div role="row" className={cn("grid items-center border-b border-line-sheet py-[13px] last:border-b-0", gridCols, rowShellClass(flags, "desktop"))}>
      {children}
    </div>
  );
}

/** Small muted pill, same shape/wording as the /franchises index's Active/Departed badge — Task
 * 29's Real Career table only surfaces the DEPARTED case inline (an implicit "active" reads fine
 * without a badge; every other row on the site already treats absence-of-badge as the norm). */
function DepartedBadge() {
  return (
    <span className="display shrink-0 rounded-full border border-line-sheet-strong px-2 py-0.5 text-[10px] tracking-[0.16em] text-muted">
      Departed
    </span>
  );
}

function FranchiseCell({
  franchiseId,
  franchiseName,
  flags,
  showChampionBadge = true,
  trailing = null,
}: {
  franchiseId: number;
  franchiseName: string;
  flags: FranchiseNameFlags;
  showChampionBadge?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <span role="cell" className="flex min-w-0 items-center gap-2">
      <Link href={`/franchises/${franchiseId}`} className="min-w-0 hover:underline">
        <FranchiseName
          franchise={{ id: franchiseId, name: franchiseName, ...flags }}
          size="row"
          surfaceBehind={flags.isChampion ? "var(--color-sheet-raised)" : "var(--color-sheet)"}
        />
      </Link>
      {showChampionBadge && flags.isChampion ? <ChampionBadge /> : null}
      {trailing}
    </span>
  );
}

function Last5Squares({ sequence }: { sequence: ("W" | "L" | "T")[] }) {
  return (
    <span role="cell" className="flex items-center justify-end gap-1">
      {sequence.map((r, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={cn("h-[9px] w-[9px] shrink-0", r === "W" ? "bg-kelly" : r === "L" ? "bg-loss" : "bg-line-sheet-strong")}
        />
      ))}
    </span>
  );
}

function StreakText({ streak }: { streak: Streak }) {
  if (!streak.type) return <span className="text-[15px] text-muted">—</span>;
  return <span className={cn("display text-[17px] font-bold", streak.type === "W" ? "text-kelly" : "text-loss")}>{streak.type}{streak.count}</span>;
}

// ---------------------------------------------------------------------------
// Real tab — dispatches to the season table or the Task 29 Career table.
// ---------------------------------------------------------------------------

const REAL_SEASON_GRID = "grid-cols-[52px_1fr_110px_110px_110px_150px_90px]";
const REAL_SEASON_GRID_PHONE = "grid-cols-[24px_1fr_74px_58px]";

function RealTab({
  scope,
  seasonStatus,
  identityFlags,
}: {
  scope: StandingsScope;
  seasonStatus?: "upcoming" | "active" | "complete";
  identityFlags: IdentityFlags;
}) {
  if (scope === "career") return <RealCareerTable identityFlags={identityFlags} />;
  return <RealSeasonTable season={scope} seasonStatus={seasonStatus ?? "upcoming"} identityFlags={identityFlags} />;
}

function RealSeasonTable({
  season,
  seasonStatus,
  identityFlags,
}: {
  season: number;
  seasonStatus: "upcoming" | "active" | "complete";
  identityFlags: IdentityFlags;
}) {
  const rows = getStandingsReal(season);
  const hasAnyGames = rows.some((r) => r.wins + r.losses + r.ties > 0);

  if (!hasAnyGames) {
    return <p className="text-sm text-muted">{seasonStatus === "upcoming" ? `${season} hasn't started yet.` : "No games recorded yet."}</p>;
  }

  return (
    <>
      {/* Desktop / tablet — full 7-column grid, always expanded. */}
      <div role="table" className="hidden md:block">
        <HeaderRow columns={REAL_SEASON_HEADERS} gridCols={REAL_SEASON_GRID} leftAlignCount={2} density="desktop" />
        {rows.map((row, i) => (
          <RealRow key={row.franchiseId} row={row} rank={i + 1} identityFlags={identityFlags} />
        ))}
      </div>

      {/* Phone — 4 columns, badges/streak fold to a second line, PA/Last5/full streak behind a
          row tap (a <details> element — server-rendered, no client state). */}
      <div role="table" className="md:hidden">
        <HeaderRow columns={REAL_SEASON_HEADERS_PHONE} gridCols={REAL_SEASON_GRID_PHONE} leftAlignCount={2} density="phone" />
        {rows.map((row, i) => (
          <RealRowPhone key={row.franchiseId} row={row} rank={i + 1} identityFlags={identityFlags} />
        ))}
      </div>
    </>
  );
}

function RealRow({ row, rank, identityFlags }: { row: StandingsRealRow; rank: number; identityFlags: IdentityFlags }) {
  const flags = resolveFranchiseFlags(identityFlags, row.franchiseId);
  const displayRank = row.finalStanding ?? rank;
  return (
    <StandingsGridRow gridCols={REAL_SEASON_GRID} flags={flags}>
      <span role="cell" className={cn("display text-[19px] font-bold", flags.isChampion ? "text-gold-ink" : "text-muted")}>
        {displayRank}
      </span>
      <FranchiseCell franchiseId={row.franchiseId} franchiseName={row.franchiseName} flags={flags} />
      <span role="cell" className={cn("text-right text-[15px] font-semibold tabular-nums", flags.isSacko ? "text-muted" : "text-ink")}>
        {formatWLT(row.wins, row.losses, row.ties)}
      </span>
      <span role="cell" className={cn("text-right text-[15px] tabular-nums", flags.isSacko ? "text-muted" : "text-ink")}>
        {row.pointsFor.toFixed(1)}
      </span>
      <span role="cell" className="text-right text-[15px] tabular-nums text-muted">
        {row.pointsAgainst.toFixed(1)}
      </span>
      <Last5Squares sequence={row.last5Sequence} />
      <span role="cell" className="text-right">
        <StreakText streak={row.streak} />
      </span>
    </StandingsGridRow>
  );
}

/** "Champion · W6" / "Belt · W2" / "You · L1" / "Sacko · L9" / bare "W1" when no flag applies. */
function phoneBadgeLine(flags: FranchiseNameFlags, streak: Streak): string {
  const prefix = flags.isChampion ? "Champion" : flags.holdsBelt ? "Belt" : flags.isViewer ? "You" : flags.isSacko ? "Sacko" : null;
  const streakText = streak.type ? `${streak.type}${streak.count}` : "—";
  return prefix ? `${prefix} · ${streakText}` : streakText;
}

function RealRowPhone({ row, rank, identityFlags }: { row: StandingsRealRow; rank: number; identityFlags: IdentityFlags }) {
  const flags = resolveFranchiseFlags(identityFlags, row.franchiseId);
  const displayRank = row.finalStanding ?? rank;
  return (
    <details role="row" className={cn("group border-b border-line-sheet [&::-webkit-details-marker]:hidden", rowShellClass(flags, "phone"))}>
      <summary className="grid cursor-pointer list-none grid-cols-[24px_1fr_74px_58px] items-center py-[11px] marker:hidden">
        <span className={cn("display text-base font-bold", flags.isChampion ? "text-gold-ink" : "text-muted")}>{displayRank}</span>
        <span className="min-w-0 pr-2">
          <Link
            href={`/franchises/${row.franchiseId}`}
            className={cn(
              "display block truncate text-base font-bold",
              flags.isChampion ? "text-gold-ink" : flags.isSacko ? "text-tarnish-ink" : "text-ink",
            )}
          >
            {row.franchiseName}
          </Link>
          <span
            className={cn(
              "display block text-[10px] tracking-[0.16em]",
              flags.isChampion ? "text-gold-ink" : flags.isViewer ? "text-kelly" : flags.isSacko ? "text-tarnish-fill" : "text-muted",
            )}
          >
            {phoneBadgeLine(flags, row.streak)}
          </span>
        </span>
        <span className={cn("text-right text-sm font-semibold tabular-nums", flags.isSacko ? "text-muted" : "text-ink")}>
          {formatWLT(row.wins, row.losses, row.ties)}
        </span>
        <span className={cn("text-right text-sm tabular-nums", flags.isSacko ? "text-muted" : "text-ink")}>{row.pointsFor.toFixed(1)}</span>
      </summary>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pb-3 pl-6 text-sm text-muted">
        <span>PA {row.pointsAgainst.toFixed(1)}</span>
        <span className="flex items-center gap-1.5">
          Last 5 <Last5Squares sequence={row.last5Sequence} />
        </span>
        <span className="flex items-center gap-1.5">
          Streak <StreakText streak={row.streak} />
        </span>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Real tab — Career scope (Task 29). Different columns from the season table
// (Win %, Seasons, Champs, Sackos instead of Last 5/Streak, which don't mean
// anything summed across a career — honestly omitted rather than faked), so
// its own grid/row components rather than reusing RealRow. One grid at every
// width (horizontal scroll on phone), matching how the pre-merge Luck/
// All-Play tabs behaved — see columns.tsx's note on why this table doesn't
// get the same phone-collapse treatment as the merged Luck table.
// ---------------------------------------------------------------------------

const REAL_CAREER_GRID = "grid-cols-[52px_1fr_100px_90px_100px_100px_90px_90px_90px]";

function RealCareerTable({ identityFlags }: { identityFlags: IdentityFlags }) {
  const rows = getStandingsRealCareer();
  const hasAnyGames = rows.some((r) => r.wins + r.losses + r.ties > 0);

  if (!hasAnyGames) {
    return <p className="text-sm text-muted">No games recorded yet.</p>;
  }

  return (
    <div className="flex flex-col gap-[22px]">
      <p className="max-w-[820px] text-[16px] leading-[1.55] text-muted">
        All-time record across every season this league has played, sorted by win percentage. Departed franchises are included and marked —
        career is history, not a current roster.
      </p>
      {/* min-w lives on ONE inner wrapper, never per-row: per-row min-width breaks the identity
          rows' negative-margin trick under border-box sizing (their content box comes out 15px
          narrower than plain rows when min-width wins), skewing columns — user-reported. */}
      <div role="table" className="overflow-x-auto">
        <div className="min-w-[980px]">
          <HeaderRow columns={REAL_CAREER_HEADERS} gridCols={REAL_CAREER_GRID} leftAlignCount={2} density="desktop" />
          {rows.map((row, i) => (
            <RealCareerRow key={row.franchiseId} row={row} rank={i + 1} identityFlags={identityFlags} />
          ))}
        </div>
      </div>
    </div>
  );
}

function RealCareerRow({ row, rank, identityFlags }: { row: StandingsRealCareerRow; rank: number; identityFlags: IdentityFlags }) {
  const flags = resolveFranchiseFlags(identityFlags, row.franchiseId);
  return (
    <StandingsGridRow gridCols={REAL_CAREER_GRID} flags={flags}>
      <span role="cell" className={cn("display text-[19px] font-bold", flags.isChampion ? "text-gold-ink" : "text-muted")}>
        {rank}
      </span>
      <FranchiseCell
        franchiseId={row.franchiseId}
        franchiseName={row.franchiseName}
        flags={flags}
        trailing={!row.active ? <DepartedBadge /> : null}
      />
      <span role="cell" className={cn("text-right text-[15px] font-semibold tabular-nums", flags.isSacko ? "text-muted" : "text-ink")}>
        {formatWLT(row.wins, row.losses, row.ties)}
      </span>
      <span role="cell" className="text-right text-[15px] font-semibold tabular-nums text-ink">
        {formatPct(row.winPct)}
      </span>
      <span role="cell" className="text-right text-[15px] tabular-nums text-muted">
        {formatWholeCommas(row.pointsFor)}
      </span>
      <span role="cell" className="text-right text-[15px] tabular-nums text-muted">
        {formatWholeCommas(row.pointsAgainst)}
      </span>
      <span role="cell" className="text-right text-[15px] tabular-nums text-muted">
        {row.seasons}
      </span>
      <span role="cell" className={cn("text-right text-[15px] font-semibold tabular-nums", row.championships > 0 ? "text-gold-ink" : "text-muted")}>
        {row.championships}
      </span>
      <span role="cell" className={cn("text-right text-[15px] tabular-nums", row.sackos > 0 ? "text-tarnish-ink" : "text-muted")}>
        {row.sackos}
      </span>
    </StandingsGridRow>
  );
}

// ---------------------------------------------------------------------------
// Luck tab (Task 29: merged with the former All-Play tab — the All-Play
// record column now lives here, and ?tab=allplay falls back to this tab).
// Shares one row shape/renderer across season and career scope.
// ---------------------------------------------------------------------------

const LUCK_GRID = "grid-cols-[1fr_100px_130px_100px_110px_120px_100px]";
const LUCK_GRID_PHONE = "grid-cols-[1fr_84px_104px_84px]";

function LuckTab({ scope, identityFlags }: { scope: StandingsScope; identityFlags: IdentityFlags }) {
  const rows = scope === "career" ? getStandingsLuckCareer() : getStandingsLuck(scope);
  const hasAnyGames = rows.some((r) => r.closeWins + r.closeLosses > 0 || r.luckTotal !== null);

  if (!hasAnyGames) {
    return <p className="text-sm text-muted">No games recorded yet.</p>;
  }

  return (
    <div className="flex flex-col gap-[22px]">
      <p className="max-w-[820px] text-[16px] leading-[1.55] text-muted">
        Luck sums each week&apos;s gap between a team&apos;s real result and its all-play &ldquo;should-have&rdquo; result. Positive means the
        schedule broke your way. Negative means it didn&apos;t, and you&apos;ve told everyone about it.
      </p>

      {/* Desktop / tablet — full 7-column grid. min-w on ONE inner wrapper, never per-row (same
          identity-row alignment hazard as the Career table — see RealCareerTable's comment). */}
      <div role="table" className="hidden overflow-x-auto md:block">
        <div className="min-w-[880px]">
          <HeaderRow columns={LUCK_HEADERS} gridCols={LUCK_GRID} density="desktop" />
          {rows.map((row) => (
            <LuckRow key={row.franchiseId} row={row} identityFlags={identityFlags} />
          ))}
        </div>
      </div>

      {/* Phone — 4 headline columns (Franchise/Luck/All-Play/Gap), the rest behind a row tap —
          the same details-element collapse the Real tab uses, extended here now that this table
          carries 7 columns instead of the old Luck tab's 6. */}
      <div role="table" className="md:hidden">
        <HeaderRow columns={LUCK_HEADERS_PHONE} gridCols={LUCK_GRID_PHONE} density="phone" />
        {rows.map((row) => (
          <LuckRowPhone key={row.franchiseId} row={row} identityFlags={identityFlags} />
        ))}
      </div>
    </div>
  );
}

function LuckRow({ row, identityFlags }: { row: StandingsLuckRow; identityFlags: IdentityFlags }) {
  const flags = resolveFranchiseFlags(identityFlags, row.franchiseId);
  const luckColor = row.luckTotal === null || row.luckTotal === 0 ? "text-muted" : row.luckTotal > 0 ? "text-kelly" : "text-loss";
  const gapColor = row.gap > 0 ? "text-kelly" : row.gap < 0 ? "text-loss" : "text-muted";
  return (
    <StandingsGridRow gridCols={LUCK_GRID} flags={flags}>
      <FranchiseCell franchiseId={row.franchiseId} franchiseName={row.franchiseName} flags={flags} />
      <span role="cell" className={cn("text-right text-[15px] font-semibold tabular-nums", luckColor)}>
        {row.luckTotal !== null ? formatSigned(row.luckTotal, 2) : "—"}
      </span>
      <span role="cell" className="text-right text-[15px] tabular-nums text-muted">
        {formatWLT(row.closeWins, row.closeLosses, 0)}
      </span>
      <span role="cell" className="text-right text-[15px] tabular-nums text-muted">
        {formatPct(row.realWinPct)}
      </span>
      <span role="cell" className="text-right text-[15px] tabular-nums text-ink">
        {formatWLT(row.allplayW, row.allplayL, row.allplayT)}
      </span>
      <span role="cell" className="text-right text-[15px] font-semibold tabular-nums text-ink">
        {formatPct(row.allplayWinPct)}
      </span>
      <span role="cell" className={cn("text-right text-[15px] tabular-nums", gapColor)}>
        {formatSigned(row.gap * 100, 1)}pp
      </span>
    </StandingsGridRow>
  );
}

function LuckRowPhone({ row, identityFlags }: { row: StandingsLuckRow; identityFlags: IdentityFlags }) {
  const flags = resolveFranchiseFlags(identityFlags, row.franchiseId);
  const luckColor = row.luckTotal === null || row.luckTotal === 0 ? "text-muted" : row.luckTotal > 0 ? "text-kelly" : "text-loss";
  const gapColor = row.gap > 0 ? "text-kelly" : row.gap < 0 ? "text-loss" : "text-muted";
  return (
    <details role="row" className={cn("group border-b border-line-sheet [&::-webkit-details-marker]:hidden", rowShellClass(flags, "phone"))}>
      <summary className={cn("grid cursor-pointer list-none items-center py-[11px] marker:hidden", LUCK_GRID_PHONE)}>
        <FranchiseCell franchiseId={row.franchiseId} franchiseName={row.franchiseName} flags={flags} />
        <span className={cn("text-right text-sm font-semibold tabular-nums", luckColor)}>
          {row.luckTotal !== null ? formatSigned(row.luckTotal, 2) : "—"}
        </span>
        <span className="text-right text-sm tabular-nums text-ink">{formatWLT(row.allplayW, row.allplayL, row.allplayT)}</span>
        <span className={cn("text-right text-sm tabular-nums", gapColor)}>{formatSigned(row.gap * 100, 1)}pp</span>
      </summary>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pb-3 pl-6 text-sm text-muted">
        <span>Close {formatWLT(row.closeWins, row.closeLosses, 0)}</span>
        <span>Real % {formatPct(row.realWinPct)}</span>
        <span>All-Play % {formatPct(row.allplayWinPct)}</span>
      </div>
    </details>
  );
}
