import Link from "next/link";
import { notFound } from "next/navigation";
import { cn } from "@/components/ui/cn";
import { playoffTierLabel, weekTypeLabel } from "@/components/history/format";
import { MatchupCard, type MatchupCardStatus } from "@/features/scoreboard/components/MatchupCard";
import { LiveWeekHubGrid, type LiveWeekHubCardData } from "@/features/live/LiveWeekHubGrid";
import { WeekAchievementsStrip } from "@/components/history/WeekAchievementsStrip";
import { getWeekAchievements } from "@/server/queries/achievements";
import { getDb } from "@/server/db/client";
import { requireManager } from "@/server/auth/guard";
import { getIdentityFlags, resolveFranchiseFlags } from "@/server/queries/identity";
import { getLatestMatchupWeek, getWeekMatchupRows, getWeekNav, getWeekSuperlatives, sortWeekHubCards, type WeekMatchupRow } from "@/server/queries/matchups";
import { getSeasonOptions } from "@/server/queries/standings";
import type { SeasonSuperlatives } from "@/server/queries/seasons";

export default async function WeekHubPage({ params }: { params: Promise<{ year: string; week: string }> }) {
  const { year: yearParam, week: weekParam } = await params;
  const season = Number(yearParam);
  const week = Number(weekParam);
  if (!Number.isInteger(season) || !Number.isInteger(week)) notFound();

  const manager = await requireManager();
  const identityFlags = getIdentityFlags(getDb(), manager.id);

  const rows = getWeekMatchupRows(season, week);
  const nav = getWeekNav(season, week);
  if (rows.length === 0) notFound();

  const anyFinal = rows.some((r) => r.isFinal);
  const superlatives = anyFinal ? getWeekSuperlatives(season, week) : null;

  const seasonOptions = getSeasonOptions();
  const seasonStatus = seasonOptions.find((s) => s.season === season)?.status ?? "upcoming";
  const latestTarget = getLatestMatchupWeek();
  const isCurrentWeek = latestTarget !== null && latestTarget.season === season && latestTarget.week === week;
  const showLiveState = seasonStatus === "active" && isCurrentWeek;

  const withRank = rows.map((r) => ({
    row: r,
    beltAtStake: r.beltAtStake,
    isViewerGame: identityFlags.viewerFranchiseId !== null && (r.home.franchiseId === identityFlags.viewerFranchiseId || r.away?.franchiseId === identityFlags.viewerFranchiseId),
  }));
  const ranked = sortWeekHubCards(withRank);

  // Achievements trophy strip (Task 33 wiring wave, brief item 3) — the query itself only ever
  // returns rows for a week the achievements engine's own SETTLEMENT GATE already treated as
  // fully final (see src/engines/achievements.ts), so an unsettled week honestly renders nothing
  // rather than needing a second "is this week done" check here.
  const weekAchievements = getWeekAchievements(season, week);

  const cardData: LiveWeekHubCardData[] = ranked.map(({ row: m, beltAtStake, isViewerGame }) => {
    const tierLabel = playoffTierLabel(m.playoffTier) ?? (m.weekType !== "regular" ? weekTypeLabel(m.weekType) : null);
    const emphasis: "belt" | "viewer" | "normal" = beltAtStake ? "belt" : isViewerGame ? "viewer" : "normal";
    const superlativeLabel = superlatives ? superlativeTagFor(m, superlatives) : null;
    // Once decided, name the OUTCOME rather than repeating the pre-game "at stake" framing
    // (real-data check on 2025 Wk17's actual transfer surfaced this — the generic label read
    // oddly on an already-final belt game).
    const beltLabel = m.isFinal
      ? m.beltResult === "transfer"
        ? "Belt Changes Hands"
        : m.beltResult === "defense"
          ? "Belt Defended"
          : "Belt at Stake"
      : `Belt at stake${isViewerGame ? " · your game" : ""}`;

    return {
      matchupId: m.matchupId,
      href: `/matchups/${season}/${week}/${m.matchupId}`,
      home: { ...m.home, franchiseId: m.home.franchiseId, flags: resolveFranchiseFlags(identityFlags, m.home.franchiseId) },
      away: m.away ? { ...m.away, franchiseId: m.away.franchiseId, flags: resolveFranchiseFlags(identityFlags, m.away.franchiseId) } : null,
      isFinal: m.isFinal,
      startersRemaining: m.startersRemaining,
      beltAtStake,
      beltLabel,
      emphasis,
      superlativeLabel: tierLabel ? [superlativeLabel, tierLabel].filter(Boolean).join(" · ") || null : superlativeLabel,
      note: m.topNote?.renderedText ?? null,
    };
  });

  return (
    <div className="flex flex-col gap-0">
      <div className="flex flex-wrap items-end justify-between gap-8 border-b-2 border-ink pb-[18px]">
        <div>
          <div className="display text-[12px] tracking-[0.26em] text-kelly">{season} Season</div>
          <h1 className="display mt-1.5 text-page-title tracking-normal text-kelly-deep">Week {week}</h1>
        </div>
        <div className="flex items-center gap-5 pb-1.5">
          {nav.prevWeek !== null ? (
            <Link href={`/matchups/${season}/${nav.prevWeek}`} className="display text-[15px] tracking-[0.14em] text-muted hover:text-ink">
              &larr; Wk {nav.prevWeek}
            </Link>
          ) : null}
          {nav.nextWeek !== null ? (
            <Link href={`/matchups/${season}/${nav.nextWeek}`} className="display text-[15px] tracking-[0.14em] text-muted hover:text-ink">
              Wk {nav.nextWeek} &rarr;
            </Link>
          ) : null}
        </div>
      </div>

      <div className="mt-[20px] flex flex-wrap items-center gap-2">
        <span className="display mr-1.5 text-[11px] tracking-[0.2em] text-muted">Season</span>
        {nav.seasonJumps.map((s) => (
          <Link
            key={s.season}
            href={`/matchups/${s.season}/${s.targetWeek}`}
            className={cn(
              "display rounded-full border px-3 py-1 text-[12px] tracking-[0.1em]",
              s.season === season ? "border-kelly-deep bg-kelly-deep font-bold text-sheet" : "border-line-sheet-strong text-muted hover:text-ink",
            )}
          >
            {s.season}
          </Link>
        ))}
      </div>

      {superlatives ? <SuperlativesStrip superlatives={superlatives} /> : null}
      {weekAchievements.length > 0 ? <WeekAchievementsStrip achievements={weekAchievements} /> : null}

      {showLiveState ? (
        // Only the CURRENT week of an active season gets the live client island — every other
        // week (historical, upcoming, or the whole site offseason) renders the plain static grid
        // below with zero client JS, unchanged from before this task.
        <LiveWeekHubGrid cards={cardData} />
      ) : (
        <div className="mt-8 grid gap-5 sm:grid-cols-2">
          {cardData.map((card) => (
            <MatchupCard
              key={card.matchupId}
              href={card.href}
              home={card.home}
              away={card.away}
              status={card.isFinal ? { kind: "final" } : ({ kind: "upcoming" } satisfies MatchupCardStatus)}
              beltAtStake={card.beltAtStake}
              beltLabel={card.beltLabel}
              emphasis={card.emphasis}
              superlativeLabel={card.superlativeLabel}
              note={card.note}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Which superlative (if any) this matchup's WINNER/subject earned this week — README: the
 * FINAL card's status row shows this in the slot the live indicator otherwise occupies. Only
 * one of Top Score / Blowout / Closest Game applies per matchup; "Beatdown" is a strip-only
 * superlative, not a card tag (the brief's 4th-cell ruling covers the strip, not cards). */
function superlativeTagFor(m: WeekMatchupRow, s: SeasonSuperlatives): string | null {
  const ids = [m.home.franchiseId, m.away?.franchiseId].filter((id): id is number => id !== undefined);
  if (s.highestWeek && ids.includes(s.highestWeek.franchiseId)) return "Top Score";
  if (s.biggestBlowout && ids.includes(s.biggestBlowout.winnerFranchiseId)) return "Blowout";
  if (s.closestGame && (ids.includes(s.closestGame.franchiseIdA) || ids.includes(s.closestGame.franchiseIdB))) return "Closest Game";
  return null;
}

function SuperlativesStrip({ superlatives }: { superlatives: SeasonSuperlatives }) {
  const cells: { label: string; name: string | null; detail: string | null }[] = [
    { label: "Top score", name: superlatives.highestWeek?.franchiseName ?? null, detail: superlatives.highestWeek ? `${superlatives.highestWeek.value.toFixed(1)} pts` : null },
    {
      label: "Blowout",
      name: superlatives.biggestBlowout?.winnerName ?? null,
      detail: superlatives.biggestBlowout ? `by ${superlatives.biggestBlowout.margin.toFixed(1)} pts` : null,
    },
    {
      label: "Closest game",
      name: superlatives.closestGame ? `${superlatives.closestGame.aName} · ${superlatives.closestGame.bName}` : null,
      detail: superlatives.closestGame ? `${superlatives.closestGame.margin.toFixed(1)} pts` : null,
    },
    {
      label: "Beatdown of the week",
      name: superlatives.beatdown?.franchiseName ?? null,
      detail: superlatives.beatdown ? `by ${Math.abs(superlatives.beatdown.margin).toFixed(1)} pts` : null,
    },
  ];

  return (
    <div className="mt-7 grid grid-cols-2 gap-px border border-line-sheet bg-line-sheet lg:grid-cols-4">
      {cells.map((c) => (
        <div key={c.label} className="bg-sheet px-5 py-4">
          <div className="display text-[11px] tracking-[0.22em] text-muted">{c.label}</div>
          <div className="display mt-1.5 text-[26px] leading-[1.05] text-ink">{c.name ?? "—"}</div>
          {c.detail ? <div className="mt-0.5 text-[15px] text-muted">{c.detail}</div> : null}
        </div>
      ))}
    </div>
  );
}
