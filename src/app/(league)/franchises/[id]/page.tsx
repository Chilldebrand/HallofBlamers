import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BeltMark } from "@/components/league/FranchiseName";
import { SectionHeading } from "@/components/league/SectionHeading";
import { cn } from "@/components/ui/cn";
import { AchievementTrophyCase } from "@/components/history/AchievementTrophyCase";
import { EloChart } from "@/components/history/EloChart";
import {
  endReasonLabel,
  formatEfficiency,
  formatSigned,
  formatSpan,
  formatWholeCommas,
  formatWinPctBaseball,
  formatWLT,
  weekTypeLabel,
} from "@/components/history/format";
import { H2HStripTable, type H2HStripRow } from "@/components/history/H2HStripTable";
import { getDb } from "@/server/db/client";
import { requireManager } from "@/server/auth/guard";
import { getIdentityFlags, resolveFranchiseFlags } from "@/server/queries/identity";
import { getFranchiseAchievements } from "@/server/queries/achievements";
import { getFranchiseH2HGameLogs } from "@/server/queries/h2h";
import {
  countActiveFranchisesWithoutBelt,
  findEloPeak,
  getFranchiseBeltHistory,
  getFranchiseEloSeries,
  getFranchiseH2H,
  getFranchiseHeader,
  getFranchiseIndex,
  getFranchiseRecords,
  getFranchiseSeasons,
} from "@/server/queries/franchises";
import { RECORD_KEY_META } from "@/server/queries/records";

export default async function FranchiseProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isInteger(id)) notFound();

  const header = getFranchiseHeader(id);
  if (!header) notFound();

  const manager = await requireManager();
  const identityFlags = getIdentityFlags(getDb(), manager.id);
  const flags = resolveFranchiseFlags(identityFlags, id);

  const eloSeries = getFranchiseEloSeries(id);
  const seasonRows = getFranchiseSeasons(id);
  const beltRows = getFranchiseBeltHistory(id);
  const h2hRows = getFranchiseH2H(id);
  const recordRows = getFranchiseRecords(id);
  const achievementGroups = getFranchiseAchievements(id);
  const eloPeak = findEloPeak(eloSeries.points);
  // Range end: the departure season for a departed franchise, otherwise the most recent season
  // with real elo_history data (never `new Date().getFullYear()` — a dynamic-SSR page shouldn't
  // derive from wall-clock time when the actual data already answers "through when").
  const eloRangeEnd = header.departedSeason ?? (eloSeries.points.length > 0 ? eloSeries.points[eloSeries.points.length - 1]!.season : header.joinedSeason);
  const eloSummary = eloPeak ? `${header.joinedSeason} – ${eloRangeEnd} · peak ${Math.round(eloPeak.elo)} in ${eloPeak.season} Wk ${eloPeak.week}` : null;

  // Task 33 audit catch: was one `getFranchiseH2HGameLog` query PER opponent inside this map
  // (an N+1) — now a single batched query up front, looked up per row below.
  const h2hGameLogs = getFranchiseH2HGameLogs(id);
  const h2hStripRows: H2HStripRow[] = h2hRows.map((r) => ({
    opponentId: r.opponentId,
    opponentName: r.opponentName,
    wins: r.wins,
    losses: r.losses,
    ties: r.ties,
    games: r.games,
    avgMargin: r.avgMargin,
    streakText: r.streakText,
    flags: resolveFranchiseFlags(identityFlags, r.opponentId),
    recentResults: h2hGameLogs.get(r.opponentId) ?? [],
  }));

  return (
    <div className="flex flex-col gap-0">
      <div className="display text-[12px] tracking-[0.24em] text-muted">
        <Link href="/franchises" className="text-kelly hover:underline">
          &larr; Franchises
        </Link>
      </div>

      <FranchiseHeaderBlock header={header} isChampion={flags.isChampion} isSacko={flags.isSacko} />

      <StatGrid header={header} />

      <section className="mt-11">
        <SectionHeading right={achievementGroups.length > 0 ? `${achievementGroups.length} type${achievementGroups.length === 1 ? "" : "s"} earned` : null}>
          Achievements
        </SectionHeading>
        <div className="mt-[18px]">
          <AchievementTrophyCase groups={achievementGroups} />
        </div>
      </section>

      <section className="mt-11">
        <SectionHeading right={eloSummary}>Elo History</SectionHeading>
        <div className="mt-[18px]">
          <EloChart series={eloSeries} />
        </div>
      </section>

      <section className="mt-11">
        <SectionHeading>Season by Season</SectionHeading>
        <SeasonTable rows={seasonRows} />
      </section>

      <div className="mt-11 grid grid-cols-1 gap-11 lg:grid-cols-[1.2fr_1fr] lg:gap-[44px]">
        <div className="flex flex-col gap-10">
          <section>
            <SectionHeading
              icon={<BeltMark size="heading" surfaceBehind="var(--color-sheet)" />}
              right={
                beltRows.length > 0
                  ? `${beltRows.length} reign${beltRows.length === 1 ? "" : "s"} · ${beltRows.reduce((s, r) => s + r.defenses, 0)} defenses · ${beltRows.reduce((s, r) => s + r.weeksHeld, 0)} weeks held`
                  : null
              }
            >
              Belt History
            </SectionHeading>
            <BeltHistory header={header} beltRows={beltRows} />
          </section>

          {recordRows.length > 0 ? (
            <section>
              <SectionHeading>Record Book Entries</SectionHeading>
              <ul className="flex flex-col">
                {recordRows.map((r) => {
                  const meta = RECORD_KEY_META[r.recordKey];
                  const gold = meta.group === "belt" || meta.group === "championship";
                  return (
                    <li
                      key={`${r.recordKey}-${r.rank}`}
                      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line-sheet-soft py-3 last:border-b-0"
                    >
                      <span className={cn("text-[15px]", gold ? "text-gold-ink" : "text-ink")}>
                        #{r.rank} {meta.label}
                      </span>
                      <span className="tabular-nums text-[15px] text-muted">
                        {meta.format(r.value)} — {r.season}
                        {r.week ? ` Wk ${r.week}` : ""}
                        {r.weekType ? ` · ${weekTypeLabel(r.weekType)}` : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </div>

        <section>
          <SectionHeading>Head-to-Head</SectionHeading>
          <div className="mt-1">
            <H2HStripTable rows={h2hStripRows} />
          </div>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header block
// ---------------------------------------------------------------------------

function FranchiseHeaderBlock({
  header,
  isChampion,
  isSacko,
}: {
  header: NonNullable<ReturnType<typeof getFranchiseHeader>>;
  isChampion: boolean;
  isSacko: boolean;
}) {
  const nameColor = isChampion ? "text-gold-ink" : isSacko ? "text-tarnish-ink" : "text-ink";
  const eyebrowColor = isChampion ? "text-gold-ink" : isSacko ? "text-tarnish-ink" : "text-kelly";
  const eyebrowText = isChampion ? "Franchise · reigning champion" : isSacko ? "Franchise · reigning sacko" : "Franchise";

  // Achievement badge: a career total, independent of "reigning" status (see the eyebrow above) —
  // championships take priority when a franchise has both nonzero championships and sackos in its
  // career (a judgment call; no mockup frame shows both nonzero at once — 9a/9b are "deliberately
  // the two extremes", README).
  const badge =
    header.championships > 0
      ? { label: `${header.championships}× Champion`, fill: "bg-gold-fill" }
      : header.sackos > 0
        ? { label: `${header.sackos}× Sacko`, fill: "bg-tarnish-fill" }
        : null;

  return (
    <div className="flex flex-wrap items-end justify-between gap-10 border-b-2 border-ink pb-5 pt-[18px]">
      <div>
        <div className={cn("display text-[12px] tracking-[0.26em]", eyebrowColor)}>{eyebrowText}</div>
        <h1 className={cn("display mt-2 text-franchise-name tracking-normal", nameColor)}>{header.name}</h1>
        <div className="mt-2.5 text-[15px] text-muted">
          Managed by{" "}
          {header.managers.map((m, i) => (
            <span key={`${m.name}-${m.fromSeason}`}>
              {i > 0 ? ", " : ""}
              {m.name} <span className="text-muted/80">({m.fromSeason}{m.toSeason ? `–${m.toSeason}` : "–present"})</span>
            </span>
          ))}
          {" · joined "}
          {header.joinedSeason}
          {" · "}
          {header.seasons} season{header.seasons === 1 ? "" : "s"}
        </div>
      </div>
      <div className="flex items-center gap-2.5 pb-2">
        {badge ? (
          <span className={cn("display shrink-0 px-2.5 py-[5px] text-[11px] tracking-[0.18em] text-sheet", badge.fill)}>{badge.label}</span>
        ) : null}
        <span className="display shrink-0 rounded-full border border-line-sheet-strong px-2.5 py-1 text-[11px] tracking-[0.18em] text-muted">
          {header.active ? "Active" : `Departed ${header.departedSeason ?? ""}`}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat grid — 8 cells, 2 conditional (README, Franchise "Stat grid")
// ---------------------------------------------------------------------------

function StatCell({
  label,
  value,
  tone,
  raisedClass,
  icon,
}: {
  label: string;
  value: ReactNode;
  /** "muted" (Task 33 audit catch — Sackos' zero case): a de-emphasized, non-noteworthy value —
   * distinct from plain "text-ink", which reads as a normal/notable number. */
  tone?: "gold" | "tarnish" | "kelly" | "loss" | "muted";
  raisedClass?: string;
  icon?: ReactNode;
}) {
  const toneClass =
    tone === "gold" ? "text-gold-ink" : tone === "tarnish" ? "text-tarnish-ink" : tone === "kelly" ? "text-kelly-deep" : tone === "loss" ? "text-loss" : tone === "muted" ? "text-muted" : "text-ink";
  const labelToneClass = tone === "gold" ? "text-gold-ink" : tone === "tarnish" ? "text-tarnish-ink" : "text-muted";
  return (
    <div className={cn("px-[18px] py-4", raisedClass ?? "bg-sheet")}>
      <div className="flex items-center gap-[7px]">
        {icon}
        <div className={cn("display text-[10px] tracking-[0.18em]", labelToneClass)}>{label}</div>
      </div>
      <div className={cn("display mt-1 text-[26px] font-bold leading-none", toneClass)}>{value}</div>
    </div>
  );
}

function StatGrid({ header }: { header: NonNullable<ReturnType<typeof getFranchiseHeader>> }) {
  return (
    <div className="mt-[26px] grid grid-cols-2 gap-px border border-line-sheet bg-line-sheet md:grid-cols-8">
      <StatCell label="Career" value={formatWLT(header.wins, header.losses, header.ties)} />
      <StatCell label="Win %" value={formatWinPctBaseball(header.winPct)} />
      <div className="hidden md:block">
        <StatCell label="Points For" value={formatWholeCommas(header.pointsFor)} />
      </div>
      <div className="hidden md:block">
        <StatCell label="Points Against" value={formatWholeCommas(header.pointsAgainst)} />
      </div>
      <div className="hidden md:block">
        <StatCell label="Sackos" value={header.sackos} tone={header.sackos > 0 ? "tarnish" : "muted"} raisedClass={header.sackos > 0 ? "bg-sacko-cell" : undefined} />
      </div>
      <StatCell label="Current Elo" value={Math.round(header.currentElo)} tone={header.currentElo >= 1500 ? "kelly" : "loss"} />
      <div className="hidden md:block">
        <StatCell label="Peak Elo" value={Math.round(header.peakElo)} />
      </div>
      <StatCell
        label="Belt Reigns"
        value={header.beltReignCount}
        tone={header.beltReignCount > 0 ? "gold" : undefined}
        raisedClass={header.beltReignCount > 0 ? "bg-sheet-raised" : undefined}
        icon={header.beltReignCount > 0 ? <BeltMark size="row" surfaceBehind={header.beltReignCount > 0 ? "var(--color-sheet-raised)" : "var(--color-sheet)"} /> : null}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Season by season
// ---------------------------------------------------------------------------

const SEASON_GRID = "grid-cols-[80px_1fr_92px_92px_92px_100px_80px_96px_110px_90px]";

function FinishTag({ label, fill }: { label: string; fill: string }) {
  return <span className={cn("display shrink-0 px-[6px] py-[2px] text-[9px] tracking-[0.16em] text-sheet", fill)}>{label}</span>;
}

function SeasonTable({ rows }: { rows: ReturnType<typeof getFranchiseSeasons> }) {
  if (rows.length === 0) return <p className="mt-4 text-sm text-muted">No seasons recorded yet.</p>;
  return (
    <div className="overflow-x-auto">
      <div role="table" className={cn("min-w-[900px]")}>
        <div role="row" className={cn("grid pb-2.5 pt-3", SEASON_GRID)}>
          {["Season", "Team", "W-L-T", "PF", "PA", "All-Play", "Luck", "Efficiency", "Finish", "Playoffs"].map((h, i) => (
            <span key={h} role="columnheader" className={cn("display text-[11px] tracking-[0.14em] text-muted", i > 1 ? "text-right" : "")}>
              {h}
            </span>
          ))}
        </div>
        {rows.map((s) => {
          const rowShell = s.champion
            ? "border-l-[3px] border-l-gold-fill bg-sheet-raised -ml-[15px] pl-3"
            : s.sacko
              ? "border-l-[3px] border-l-tarnish-fill -ml-[15px] pl-3"
              : "";
          return (
            <div key={s.season} role="row" className={cn("grid items-center border-b border-line-sheet py-[11px] text-[14px]", SEASON_GRID, rowShell)}>
              <span role="cell" className="font-semibold text-ink">
                <Link href={`/seasons/${s.season}`} className="hover:underline">
                  {s.season}
                </Link>
              </span>
              <span role="cell" className="truncate text-muted">
                {s.teamName}
              </span>
              <span role="cell" className="text-right tabular-nums text-ink">
                {formatWLT(s.wins, s.losses, s.ties)}
              </span>
              <span role="cell" className="text-right tabular-nums text-ink">
                {s.pointsFor.toFixed(1)}
              </span>
              <span role="cell" className="text-right tabular-nums text-muted">
                {s.pointsAgainst.toFixed(1)}
              </span>
              <span role="cell" className="text-right tabular-nums text-muted">
                {formatWLT(s.allplayW, s.allplayL, s.allplayT)}
              </span>
              <span role="cell" className="text-right tabular-nums text-muted">
                {s.luckTotal !== null ? formatSigned(s.luckTotal, 2) : "—"}
              </span>
              <span role="cell" className="text-right tabular-nums text-muted">
                {formatEfficiency(s.efficiencyAvg)}
              </span>
              {/* final_standing is ESPN's placeholder 0 until a season is fully decided — never
                  displayed as if it were a real finish. */}
              <span role="cell" className="flex items-center justify-end gap-[7px] tabular-nums text-ink">
                {s.finalStanding && s.finalStanding > 0 ? s.finalStanding : "—"}
                {/* Fix round 1, finding 10: "Champ" (abbreviated, not "Champion") is the mockup's own
                    literal text for this exact tag — Franchise.dc.html's season-row Finish cell reads
                    `>Champ<` verbatim (frame 9a, both the 2021 and 2025 championship rows, desktop and
                    phone). Confirmed via source before keeping it — not an invented abbreviation. */}
                {s.champion ? <FinishTag label="Champ" fill="bg-gold-fill" /> : null}
                {s.sacko ? <FinishTag label="Sacko" fill="bg-tarnish-fill" /> : null}
              </span>
              <span role="cell" className="text-right text-muted">
                {s.madePlayoffs ? "Yes" : "—"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Belt history — real empty state for a franchise that's never held it
// (README, Franchise "Belt history": compute the real numbers, not the
// mockup's fictional "Nine seasons, 112 games, zero reigns").
// ---------------------------------------------------------------------------

function BeltHistory({
  header,
  beltRows,
}: {
  header: NonNullable<ReturnType<typeof getFranchiseHeader>>;
  beltRows: ReturnType<typeof getFranchiseBeltHistory>;
}) {
  if (beltRows.length === 0) {
    const games = header.wins + header.losses + header.ties;
    const activeNoBeltCount = header.active ? countActiveFranchisesWithoutBelt(getFranchiseIndex()) : 0;
    const uniquenessClause = header.active
      ? activeNoBeltCount === 1
        ? " — the only active franchise with none."
        : ` — one of ${activeNoBeltCount} active franchises with none.`
      : ".";
    return (
      <div className="border-b border-line-sheet-soft py-6">
        <p className="text-[19px] text-ink">This franchise has never held the belt.</p>
        <p className="mt-1.5 text-[15px] text-muted">
          {header.seasons} season{header.seasons === 1 ? "" : "s"}, {games} game{games === 1 ? "" : "s"}, zero reigns{uniquenessClause}
        </p>
      </div>
    );
  }

  return (
    <div role="table">
      <div role="row" className="grid grid-cols-[70px_1fr_1fr_90px_1fr] pb-2.5 pt-3">
        {["Reign", "Span", "Won From", "Defenses", "Ended"].map((h, i) => (
          <span key={h} role="columnheader" className={cn("display text-[11px] tracking-[0.14em] text-muted", i === 3 ? "text-right" : "")}>
            {h}
          </span>
        ))}
      </div>
      {beltRows.map((r) => (
        <div
          key={r.reignNo}
          role="row"
          className={cn("grid grid-cols-[70px_1fr_1fr_90px_1fr] items-center border-b border-line-sheet-soft py-3 text-[14px] last:border-b-0", r.isCurrent ? "bg-sheet-raised" : "")}
        >
          <span role="cell" className={cn("display text-[16px] font-bold", r.isCurrent ? "text-gold-ink" : "text-ink")}>#{r.reignNo}</span>
          <span role="cell" className="text-ink">{formatSpan(r.startSeason, r.startWeek, r.endSeason, r.endWeek)}</span>
          <span role="cell" className="text-muted">
            {r.wonFromName && r.wonFromFranchiseId !== null ? (
              <Link href={`/franchises/${r.wonFromFranchiseId}`} className="hover:underline">
                {r.wonFromName}
              </Link>
            ) : (
              "Vacancy"
            )}
          </span>
          <span role="cell" className="text-right tabular-nums text-muted">{r.defenses}</span>
          <span role="cell" className={r.isCurrent ? "text-gold-ink" : "text-muted"}>{r.isCurrent ? "Current Holder" : endReasonLabel(r.endReason)}</span>
        </div>
      ))}
    </div>
  );
}
