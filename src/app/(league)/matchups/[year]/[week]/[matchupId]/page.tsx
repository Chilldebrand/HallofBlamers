import Link from "next/link";
import { notFound } from "next/navigation";
import { BeltMark, FranchiseName, type FranchiseNameFlags } from "@/components/league/FranchiseName";
import { cn } from "@/components/ui/cn";
import { formatEfficiency, formatPts, formatWLT, playoffTierLabel, weekTypeLabel } from "@/components/history/format";
import { RECORD_KEY_META } from "@/server/queries/records";
import { computeAdvantage } from "@/server/queries/h2h";
import { getDb } from "@/server/db/client";
import { requireManager } from "@/server/auth/guard";
import { getIdentityFlags, resolveFranchiseFlags } from "@/server/queries/identity";
import {
  getLatestMatchupWeek,
  getMatchupDetail,
  type MatchupContextNote,
  type MatchupDetail,
  type MatchupSideDetail,
  type RosterRow,
} from "@/server/queries/matchups";
import { getSeasonOptions } from "@/server/queries/standings";

export default async function MatchupDetailPage({ params }: { params: Promise<{ year: string; week: string; matchupId: string }> }) {
  const { year: yearParam, week: weekParam, matchupId: matchupIdParam } = await params;
  const season = Number(yearParam);
  const week = Number(weekParam);
  const matchupId = Number(matchupIdParam);
  if (!Number.isInteger(season) || !Number.isInteger(week) || !Number.isInteger(matchupId)) notFound();

  const detail = getMatchupDetail(matchupId);
  if (!detail || detail.season !== season || detail.week !== week) notFound();

  const manager = await requireManager();
  const identityFlags = getIdentityFlags(getDb(), manager.id);
  const homeFlags = resolveFranchiseFlags(identityFlags, detail.home.franchiseId);
  const awayFlags = detail.away ? resolveFranchiseFlags(identityFlags, detail.away.franchiseId) : null;

  const seasonOptions = getSeasonOptions();
  const seasonStatus = seasonOptions.find((s) => s.season === detail.season)?.status ?? "upcoming";
  const latestTarget = getLatestMatchupWeek();
  const isCurrentWeek = latestTarget !== null && latestTarget.season === detail.season && latestTarget.week === detail.week;
  const showLiveState = seasonStatus === "active" && isCurrentWeek && !detail.isFinal;

  const tierLabel = playoffTierLabel(detail.playoffTier) ?? (detail.weekType !== "regular" ? weekTypeLabel(detail.weekType) : null);

  return (
    <div className="flex flex-col gap-0">
      <div className="display flex flex-wrap items-center gap-3.5 text-[12px] tracking-[0.24em] text-muted">
        <Link href={`/matchups/${detail.season}/${detail.week}`} className="text-kelly hover:underline">
          &larr; Week {detail.week}
        </Link>
        <span>
          {detail.season} · Week {detail.week} · {tierLabel ?? "Regular season"}
        </span>
      </div>

      <ScoreHead detail={detail} homeFlags={homeFlags} awayFlags={awayFlags} showLiveState={showLiveState} />

      {detail.belt ? <BeltBanner belt={detail.belt} home={detail.home} away={detail.away} /> : null}

      {detail.boxScore ? (
        <section className="mt-11 grid gap-9 md:grid-cols-2">
          <BoxScoreTable
            franchiseId={detail.home.franchiseId}
            franchiseName={detail.home.franchiseName}
            flags={homeFlags}
            rows={detail.boxScore.home}
            isFinal={detail.isFinal}
          />
          {detail.away && awayFlags ? (
            <BoxScoreTable
              franchiseId={detail.away.franchiseId}
              franchiseName={detail.away.franchiseName}
              flags={awayFlags}
              rows={detail.boxScore.away}
              isFinal={detail.isFinal}
            />
          ) : null}
        </section>
      ) : (
        <section className="mt-11">
          <p className="text-sm text-muted">No lineup data archived for this week.</p>
        </section>
      )}

      <FootSection detail={detail} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Score head
// ---------------------------------------------------------------------------

function scoreDisplay(side: MatchupSideDetail, isFinal: boolean): string {
  if (isFinal) return side.score.toFixed(1);
  return side.projected !== null ? `${side.projected.toFixed(1)} proj.` : "—";
}

/**
 * Leader/trailer coloring only applies once the game is FINAL — matching the honest-data rule
 * this page already followed pre-redesign (`matchups.homeScore`/`awayScore` are real DB columns
 * that hold ESPN's 0.0 "not yet played" sentinel until final, so an in-progress week's raw score
 * is not a trustworthy "who's ahead" signal without a live partial-score feed, which is the
 * separate live-backend branch's job, not this redesign's).
 */
function efficiencyLine(side: MatchupSideDetail): string {
  const text = `Optimal ${formatPts(side.optimal.optimal)} · left on bench ${formatPts(side.optimal.benchLeft)} · ${formatEfficiency(side.optimal.efficiency)} efficient`;
  return side.unplayedStarters !== null && side.unplayedStarters > 0 ? `${text} · ${side.unplayedStarters} to play` : text;
}

function ScoreHead({
  detail,
  homeFlags,
  awayFlags,
  showLiveState,
}: {
  detail: MatchupDetail;
  homeFlags: FranchiseNameFlags;
  awayFlags: FranchiseNameFlags | null;
  showLiveState: boolean;
}) {
  const decided = detail.isFinal && detail.away !== null;
  const homeWins = decided && detail.home.score > detail.away!.score;
  const awayWins = decided && detail.away !== null && detail.away.score > detail.home.score;

  const belt = detail.belt;
  const homeRole: SideRole = belt
    ? belt.holderId === detail.home.franchiseId
      ? { kind: "holder", reignNo: belt.holderReignNo }
      : { kind: "challenger" }
    : { kind: "none" };
  const awayRole: SideRole = belt
    ? belt.holderId === detail.away?.franchiseId
      ? { kind: "holder", reignNo: belt.holderReignNo }
      : { kind: "challenger" }
    : { kind: "none" };

  return (
    <div className="grid grid-cols-1 items-center gap-6 border-b-2 border-ink pb-[26px] pt-[22px] md:grid-cols-[1fr_auto_1fr] md:gap-9">
      <ScoreHeadSide side={detail.home} flags={homeFlags} isFinal={detail.isFinal} role={homeRole} isViewer={homeFlags.isViewer} isWinner={homeWins} decided={decided} align="left" />

      <div className="text-center">
        {showLiveState ? (
          <div className="display flex items-center justify-center gap-1.5 text-[13px] tracking-[0.2em] text-live">
            <span className="wbb-blink h-1.5 w-1.5 shrink-0 rounded-full bg-live" aria-hidden="true" />
            Live
          </div>
        ) : null}
        <div className="display mt-2.5 text-[22px] tracking-[0.1em] text-muted">vs</div>
        {detail.isFinal && detail.margin !== null ? <div className="mt-2.5 text-[14px] whitespace-nowrap text-muted">Margin {detail.margin.toFixed(1)}</div> : null}
      </div>

      {detail.away && awayFlags ? (
        <ScoreHeadSide
          side={detail.away}
          flags={awayFlags}
          isFinal={detail.isFinal}
          role={awayRole}
          isViewer={awayFlags.isViewer}
          isWinner={awayWins}
          decided={decided}
          align="right"
        />
      ) : (
        <p className="text-sm text-muted md:text-right">Bye week.</p>
      )}
    </div>
  );
}

type SideRole = { kind: "holder"; reignNo: number | null } | { kind: "challenger" } | { kind: "none" };

function ScoreHeadSide({
  side,
  flags,
  isFinal,
  role,
  isViewer,
  isWinner,
  decided,
  align,
}: {
  side: MatchupSideDetail;
  flags: FranchiseNameFlags;
  isFinal: boolean;
  role: SideRole;
  isViewer: boolean;
  isWinner: boolean;
  decided: boolean;
  align: "left" | "right";
}) {
  const nameColor = flags.isChampion ? "text-gold-ink" : flags.isSacko ? "text-tarnish-ink" : "text-ink";
  const scoreColor = decided ? (isWinner ? "text-kelly-deep" : "text-ink-trailing") : "text-ink";

  return (
    <div className={align === "right" ? "md:text-right" : ""}>
      <div className={cn("flex items-center gap-2", align === "right" ? "md:justify-end" : "")}>
        {role.kind === "holder" ? (
          <>
            <BeltMark size="matchupHeader" surfaceBehind="var(--color-sheet)" />
            <span className="display text-[11px] tracking-[0.2em] text-gold-ink">Belt holder{role.reignNo !== null ? ` · reign ${role.reignNo}` : ""}</span>
          </>
        ) : role.kind === "challenger" ? (
          <span className="display text-[11px] tracking-[0.2em] text-kelly">Challenger{isViewer ? " · you" : ""}</span>
        ) : isViewer ? (
          <span className="display text-[11px] tracking-[0.2em] text-kelly">You</span>
        ) : null}
      </div>
      <div className={cn("display mt-2 text-[46px] leading-none", nameColor)}>{side.franchiseName}</div>
      <div className={cn("display mt-2.5 text-score-detail leading-none", scoreColor)}>{scoreDisplay(side, isFinal)}</div>
      <div className="mt-2 text-[14px] text-muted">{efficiencyLine(side)}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Belt banner
// ---------------------------------------------------------------------------

type BeltInfo = NonNullable<MatchupDetail["belt"]>;

function BeltBanner({ belt, home, away }: { belt: BeltInfo; home: MatchupSideDetail; away: MatchupSideDetail | null }) {
  const nameById = new Map([[home.franchiseId, home.franchiseName], ...(away ? [[away.franchiseId, away.franchiseName] as const] : [])]);
  const holderName = belt.holderId !== null ? (nameById.get(belt.holderId) ?? "—") : "—";
  const challengerName = belt.challengerId !== null ? (nameById.get(belt.challengerId) ?? "—") : "—";

  let statement: string;
  if (belt.result === "transfer") statement = `${challengerName} took the belt from ${holderName}.`;
  else if (belt.result === "defense") statement = `${holderName} successfully defended the belt.`;
  else statement = `${holderName} defends the belt this week. A win extends the reign; a loss hands it to ${challengerName}.`;

  return (
    <div className="mt-6 flex items-start gap-3.5 border border-line-sheet-strong border-l-[3px] border-l-gold-fill bg-sheet-raised px-5 py-4">
      <BeltMark size="matchupHeader" surfaceBehind="var(--color-sheet-raised)" />
      <div>
        <div className="display text-[12px] tracking-[0.2em] text-gold-ink">Belt at Stake</div>
        <p className="mt-1 text-[17px] leading-[1.45] text-ink">{statement}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Box score
// ---------------------------------------------------------------------------

function BoxScoreTable({
  franchiseId,
  franchiseName,
  flags,
  rows,
  isFinal,
}: {
  franchiseId: number;
  franchiseName: string;
  flags: FranchiseNameFlags;
  rows: RosterRow[];
  isFinal: boolean;
}) {
  const starters = rows.filter((r) => r.isStarter);
  const bench = rows.filter((r) => !r.isStarter);
  const startersTotal = starters.reduce((sum, r) => sum + (r.points ?? 0), 0);

  return (
    <div>
      <div className="flex items-baseline justify-between border-b-2 border-ink pb-2.5">
        <FranchiseName
          franchise={{ id: franchiseId, name: franchiseName, ...flags }}
          size="heading"
          surfaceBehind="var(--color-sheet)"
          className="display text-[22px] tracking-[0.05em]"
        />
        <span className="display shrink-0 text-[11px] tracking-[0.18em] text-muted">Pts</span>
      </div>
      {starters.map((r, i) => (
        <RosterRowLine key={i} row={r} unplayed={!isFinal && r.isStarter && r.points === null} />
      ))}
      <div className="flex items-center justify-between border-t-2 border-ink py-3">
        <span className="display text-[15px] tracking-[0.14em] text-ink">Starters Total</span>
        <span className="display text-[20px] tabular-nums text-ink">{startersTotal.toFixed(1)}</span>
      </div>
      {bench.length > 0 ? (
        <div className="pt-3">
          <div className="display mb-1.5 text-[11px] tracking-[0.2em] text-muted">Bench</div>
          {bench.map((r, i) => (
            <RosterRowLine key={i} row={r} unplayed={false} muted />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RosterRowLine({ row, unplayed, muted = false }: { row: RosterRow; unplayed: boolean; muted?: boolean }) {
  return (
    <div
      className={cn(
        "grid grid-cols-[52px_1fr_60px] items-center py-2.5",
        muted ? "py-[7px]" : "border-b border-line-sheet-soft",
        unplayed ? "-mx-2 bg-viewer-fill px-2" : "",
      )}
    >
      <span className={cn("display text-[12px] tracking-[0.1em]", unplayed ? "font-semibold text-kelly" : "text-muted")}>{row.lineupSlot}</span>
      <span className={cn(muted ? "text-[14px] text-muted" : "text-[15px]", unplayed ? "font-semibold text-kelly" : "text-ink")}>
        {row.playerName} {row.proTeam && row.proTeam !== "None" ? <span className="text-muted">{row.proTeam}</span> : null}
        {unplayed ? " · playing" : ""}
      </span>
      <span
        className={cn(
          "text-right tabular-nums",
          muted ? "text-[14px] text-muted" : "text-[15px] font-semibold",
          unplayed ? "text-kelly" : "text-ink",
        )}
      >
        {formatPts(row.points)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context + Series context foot
// ---------------------------------------------------------------------------

function FootSection({ detail }: { detail: MatchupDetail }) {
  const hasContext = detail.contextNotes.length > 0;
  const hasSeries = detail.h2h !== null && detail.away !== null;
  if (!hasContext && !hasSeries) return null;

  return (
    <section className="mt-12 grid gap-9 md:grid-cols-2">
      {hasContext ? <ContextColumn notes={detail.contextNotes} /> : <div />}
      {hasSeries ? <SeriesColumn detail={detail} /> : null}
    </section>
  );
}

function ContextColumn({ notes }: { notes: MatchupContextNote[] }) {
  return (
    <div>
      <div className="display border-b border-line-sheet-strong pb-2.5 text-[12px] tracking-[0.24em] text-muted">Context</div>
      {notes.map((n, i) => (
        <div key={`${n.ruleId}-${i}`} className="border-b border-line-sheet-soft py-3.5 last:border-b-0">
          <div className="flex items-center gap-2">
            {n.isBeltNote ? <BeltMark size="inline" surfaceBehind="var(--color-sheet)" /> : null}
            <span className={cn("display text-[11px] tracking-[0.2em]", n.isBeltNote ? "text-gold-ink" : "text-muted")}>{n.franchiseName ?? "This Game"}</span>
          </div>
          <p className="mt-1.5 text-[16px] leading-[1.5] text-ink">{n.renderedText}</p>
        </div>
      ))}
    </div>
  );
}

function SeriesColumn({ detail }: { detail: MatchupDetail }) {
  const h2h = detail.h2h!;
  return (
    <div>
      <div className="display border-b border-line-sheet-strong pb-2.5 text-[12px] tracking-[0.24em] text-muted">Series Context</div>
      <div className="border-b border-line-sheet-soft py-4">
        <div className="display text-[24px] text-ink">
          <H2HAllTimeStatement h2h={h2h} />
        </div>
        <div className="mt-1 text-[15px] text-muted">All-time, including playoff meetings.</div>
      </div>
      <div className="grid grid-cols-2 gap-6 pt-4">
        <div>
          <div className="display text-[11px] tracking-[0.18em] text-muted">Largest Win</div>
          <div className="mt-1 text-[17px] text-ink">{h2h.largestWin ? `${h2h.largestWin.winnerName} by ${h2h.largestWin.value.toFixed(1)}` : "—"}</div>
          <div className="text-[14px] text-muted">{h2h.largestWin ? `${h2h.largestWin.season} Wk ${h2h.largestWin.week}` : ""}</div>
        </div>
        <div>
          <div className="display text-[11px] tracking-[0.18em] text-muted">Last Meeting</div>
          <div className="mt-1 text-[17px] text-ink">{h2h.lastMeeting ? `${h2h.lastMeeting.season} Wk ${h2h.lastMeeting.week}` : "—"}</div>
        </div>
      </div>

      {detail.records.length > 0 ? (
        <>
          <div className="display mt-8 border-b border-line-sheet-strong pb-2.5 text-[12px] tracking-[0.24em] text-muted">Record Book</div>
          {detail.records.map((r) => {
            const meta = RECORD_KEY_META[r.recordKey];
            const gold = meta.group === "belt" || meta.group === "championship";
            return (
              <div key={`${r.recordKey}-${r.rank}`} className="flex items-baseline justify-between border-b border-line-sheet-soft py-3 last:border-b-0">
                <span className={cn("text-[15px]", gold ? "text-gold-ink" : "text-ink")}>
                  #{r.rank} {meta.label}
                </span>
                <span className="text-[15px] text-muted">
                  {r.franchiseName}, {meta.format(r.value)}
                </span>
              </div>
            );
          })}
        </>
      ) : null}
    </div>
  );
}

/**
 * Fix round 1, I2 (carried over from the pre-redesign page): franchise_a is just min(franchiseId)
 * — it is NOT necessarily the side with more wins. "X leads" must be computed from the actual
 * W/L (via computeAdvantage), not attributed to franchise_a unconditionally — same bug, same fix,
 * as h2h/[a]/[b]/page.tsx's identical copy.
 */
function H2HAllTimeStatement({ h2h }: { h2h: NonNullable<MatchupDetail["h2h"]> }) {
  const wins = h2h.regW + h2h.playoffW;
  const losses = h2h.regL + h2h.playoffL;
  const ties = h2h.regT + h2h.playoffT;
  const advantage = computeAdvantage(wins, losses);

  if (advantage === "even") {
    return (
      <>
        Series tied{" "}
        <span className="tabular-nums">
          {wins}-{losses}
          {ties > 0 ? `-${ties}` : ""}
        </span>
      </>
    );
  }

  const leaderName = advantage === "leading" ? h2h.franchiseA.name : h2h.franchiseB.name;
  const trailerName = advantage === "leading" ? h2h.franchiseB.name : h2h.franchiseA.name;
  const leaderWins = advantage === "leading" ? wins : losses;
  const leaderLosses = advantage === "leading" ? losses : wins;

  return (
    <>
      {leaderName} leads <span className="tabular-nums">{formatWLT(leaderWins, leaderLosses, ties)}</span> vs. {trailerName}
    </>
  );
}
