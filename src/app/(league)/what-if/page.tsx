import type { ReactNode } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/broadcast/PageHeader";
import { FranchiseName, type FranchiseNameFlags, type FranchiseNameSize } from "@/components/league/FranchiseName";
import { cn } from "@/components/ui/cn";
import { formatWLT } from "@/components/history/format";
import { getDb } from "@/server/db/client";
import { requireManager } from "@/server/auth/guard";
import { getIdentityFlags, resolveFranchiseFlags, type IdentityFlags } from "@/server/queries/identity";
import { getStandingsReal } from "@/server/queries/standings";
import {
  getBestWorstScheduleResult,
  getDefaultWhatIfSeason,
  getOptimalLineupSeasonResult,
  getScheduleSwapResult,
  getSeasonOptions,
  getWhatIfFranchiseOptions,
  resolveWhatIfFranchise,
  resolveWhatIfFranchisePair,
  resolveWhatIfMode,
  resolveWhatIfSeason,
  type BestWorstScheduleEntry,
  type BestWorstScheduleResult,
  type OptimalLineupSeasonResult,
  type ScheduleSwapFranchiseResult,
  type WhatIfFranchiseOption,
  type WhatIfMode,
  type WhatIfSeasonRecord,
} from "@/server/queries/whatIf";

// ---------------------------------------------------------------------------
// /what-if — What-If Simulator (Task 35, roadmap §21 v1). Server-computed,
// URL-param driven, no client state (see engines/whatIf.ts for the actual
// math and its disclosed head-to-head-week rule).
// ---------------------------------------------------------------------------

const MODE_TABS: { key: WhatIfMode; label: string }[] = [
  { key: "swap", label: "Schedule Swap" },
  { key: "bestworst", label: "Best/Worst Schedule" },
  { key: "lineup", label: "Perfect Lineups" },
];

function hrefFor(mode: WhatIfMode, season: number): string {
  return `/what-if?mode=${mode}&season=${season}`;
}

function pillClass(active: boolean): string {
  return cn(
    "display rounded-full border px-3.5 py-1.5 text-[13px] tracking-[0.1em]",
    active ? "border-kelly-deep bg-kelly-deep font-bold text-sheet" : "border-line-sheet-strong text-muted hover:text-ink",
  );
}

interface WhatIfSearchParams {
  mode?: string;
  season?: string;
  franchiseA?: string;
  franchiseB?: string;
  franchise?: string;
}

export default async function WhatIfPage({ searchParams }: { searchParams: Promise<WhatIfSearchParams> }) {
  const params = await searchParams;
  const manager = await requireManager();
  const identityFlags = getIdentityFlags(getDb(), manager.id);

  const seasonOptions = getSeasonOptions();
  if (seasonOptions.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Simulator" title="What If?" />
        <p className="text-sm text-muted">No seasons on record yet.</p>
      </div>
    );
  }

  const defaultSeason = getDefaultWhatIfSeason() ?? seasonOptions[0]!.season;
  const mode = resolveWhatIfMode(params.mode);
  const season = resolveWhatIfSeason(params.season, seasonOptions, defaultSeason);
  const franchiseOptions = getWhatIfFranchiseOptions(season);

  return (
    <div className="flex flex-col gap-0">
      <PageHeader
        eyebrow="Simulator"
        title="What If?"
        right={<span className="text-[15px] text-muted">Hypothetical — none of this happened</span>}
      />

      <div className="mt-[22px] flex flex-wrap items-center gap-2">
        {seasonOptions.map((s) => (
          <Link key={s.season} href={hrefFor(mode, s.season)} className={pillClass(s.season === season)}>
            {s.season}
          </Link>
        ))}
      </div>

      <div className="mt-[26px] flex gap-0.5 border-b border-line-sheet-strong">
        {MODE_TABS.map((t) => (
          <Link
            key={t.key}
            href={hrefFor(t.key, season)}
            className={cn(
              "display border-b-2 px-4 py-2.5 text-nav-item tracking-nav-item",
              t.key === mode ? "border-ink font-bold text-ink" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>

      <div className="mt-[26px] flex flex-col gap-8">
        {franchiseOptions.length === 0 ? (
          <p className="text-sm text-muted">No franchise fielded a team in {season}.</p>
        ) : mode === "swap" ? (
          <ScheduleSwapSection season={season} franchiseOptions={franchiseOptions} params={params} identityFlags={identityFlags} />
        ) : mode === "bestworst" ? (
          <BestWorstSection season={season} franchiseOptions={franchiseOptions} params={params} identityFlags={identityFlags} />
        ) : (
          <PerfectLineupSection season={season} franchiseOptions={franchiseOptions} params={params} identityFlags={identityFlags} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared: the hypothetical-styling treatment. Task 35 brief: a what-if result
// must never be styled like a real standings table. Every result surface on
// this page renders inside this card — a dashed (never solid) border, a
// diagonal hatch wash, and an explicit "WHAT-IF" eyebrow — so it reads as a
// different KIND of surface than every solid-bordered real table on the
// site, legible at a glance without reading a word of copy. Disclosed design
// call (brief: "your design call, disclose it") — see task-35-report.md.
// ---------------------------------------------------------------------------

function WhatIfCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn("border-2 border-dashed border-line-sheet-strong bg-sheet-raised p-5", className)}
      style={{ backgroundImage: "repeating-linear-gradient(135deg, transparent 0 12px, var(--color-line-sheet-soft) 12px 13px)" }}
    >
      <p className="display mb-4 text-[11px] tracking-[0.26em] text-muted">What-If — Didn&apos;t Happen</p>
      {children}
    </div>
  );
}

function findFranchise(options: WhatIfFranchiseOption[], id: number): WhatIfFranchiseOption {
  return options.find((o) => o.id === id) ?? { id, name: "Unknown Franchise" };
}

/**
 * USER RULE (binding, 2026-08-04): identity marks on every page wherever a franchise name renders
 * as a structured element — not just the primary subject's own header. Every opponent/
 * schedule-source mention in a table or subline goes through this, never plain text. `surfaceBehind`
 * must match the ACTUAL background immediately behind the mark at that spot (h2h/[a]/[b]/page.tsx's
 * "pairing surfaces" precedent: two names sharing one surface share one surfaceBehind value).
 */
function OpponentName({
  franchiseOptions,
  identityFlags,
  franchiseId,
  size = "row",
  surfaceBehind,
}: {
  franchiseOptions: WhatIfFranchiseOption[];
  identityFlags: IdentityFlags;
  franchiseId: number;
  size?: FranchiseNameSize;
  surfaceBehind: string;
}) {
  const option = findFranchise(franchiseOptions, franchiseId);
  const flags = resolveFranchiseFlags(identityFlags, franchiseId);
  return <FranchiseName franchise={{ id: option.id, name: option.name, ...flags }} size={size} surfaceBehind={surfaceBehind} />;
}

/** English possessive suffix ONLY (not the full name) — mirrors src/engines/context.ts's
 * `possessive()` rule (bare apostrophe when the name already ends in "s") so it can be appended
 * after a <FranchiseName> component instead of a plain string. Same plain-ASCII apostrophe that
 * rule uses, not a typographic one. */
function possessiveSuffix(name: string): string {
  return name.toLowerCase().endsWith("s") ? "'" : "'s";
}

// ---------------------------------------------------------------------------
// Column-header + judgment-tag tooltips (Task 29's `.tip`/`data-tip` system,
// src/app/(league)/standings/columns.tsx precedent) — instant on hover, tap/
// focus-friendly, no client JS. Fix round 1, finding 2: every abbreviated or
// judgment column across all three modes gets one, sign/semantics-accurate.
// ---------------------------------------------------------------------------

function Th({ label, tip, align = "left", last = false }: { label: string; tip: string; align?: "left" | "right"; last?: boolean }) {
  return (
    <th
      data-tip={tip}
      tabIndex={0}
      className={cn(
        "tip display py-1.5 text-[10px] font-normal tracking-[0.14em]",
        last ? "" : "pr-2",
        align === "right" ? "tip-end text-right" : "text-left",
      )}
    >
      {label}
    </th>
  );
}

function TipTag({ tip, tone, children }: { tip: string; tone: "neutral" | "best" | "worst"; children: ReactNode }) {
  const toneClass = tone === "best" ? "border-kelly text-kelly" : tone === "worst" ? "border-loss text-loss" : "border-line-sheet-strong text-muted";
  return (
    <span data-tip={tip} tabIndex={0} className={cn("tip ml-1.5 rounded-[2px] border px-1 text-[9px] tracking-[0.12em]", toneClass)}>
      {children}
    </span>
  );
}

const selectClass = "border border-line-sheet bg-sheet px-3 py-2 text-sm text-ink";
const submitClass = "display border border-ink bg-ink px-4 py-2 text-[13px] font-bold tracking-[0.12em] text-sheet hover:bg-ink-trailing";

function PickerField({ label, name, options, selected }: { label: string; name: string; options: WhatIfFranchiseOption[]; selected: number }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="display text-[10px] tracking-[0.16em] text-muted">{label}</span>
      <select name={name} defaultValue={selected} className={selectClass}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function recordLine(r: WhatIfSeasonRecord): string {
  return formatWLT(r.wins, r.losses, r.ties);
}

// ---------------------------------------------------------------------------
// Mode 1: Schedule Swap
// ---------------------------------------------------------------------------

/**
 * Fix round 2: `nameNode`/`opponentNameNode` are pre-rendered <FranchiseName>/<OpponentName>
 * elements (never plain strings) — the same two franchises already render marked in this card's
 * header/subline/table; the verdict sentence can't be the one place they go plain again. Wording
 * is byte-identical to the pre-fix plain-string version (user-approved copy) — only the name
 * tokens changed from string interpolation to embedded nodes. Every branch is written on ONE
 * line so JSX doesn't collapse/strip the literal spaces around each embedded name.
 */
function swapVerdict(nameNode: ReactNode, opponentNameNode: ReactNode, record: WhatIfSeasonRecord, actual: WhatIfSeasonRecord): ReactNode {
  const deltaWins = record.wins - actual.wins;
  const newLine = recordLine(record);
  const realLine = recordLine(actual);
  if (deltaWins > 0) return <>Trade schedules with {opponentNameNode}? {nameNode} finishes {newLine} instead of {realLine} — thanks for nothing, actual schedule.</>;
  if (deltaWins < 0) return <>Trade schedules with {opponentNameNode}? {nameNode} finishes {newLine} instead of {realLine} — turns out the real schedule was doing you a favor.</>;
  return <>Trade schedules with {opponentNameNode}? {nameNode} still finishes {newLine}. The schedule was never the excuse.</>;
}

function ScheduleSwapSection({
  season,
  franchiseOptions,
  params,
  identityFlags,
}: {
  season: number;
  franchiseOptions: WhatIfFranchiseOption[];
  params: WhatIfSearchParams;
  identityFlags: IdentityFlags;
}) {
  const { franchiseAId, franchiseBId } = resolveWhatIfFranchisePair(params.franchiseA, params.franchiseB, franchiseOptions);
  const result = franchiseAId >= 0 ? getScheduleSwapResult(season, franchiseAId, franchiseBId) : null;

  return (
    <div className="flex flex-col gap-8">
      <form method="get" className="flex flex-wrap items-end gap-4 border border-line-sheet bg-sheet p-5">
        <input type="hidden" name="mode" value="swap" />
        <input type="hidden" name="season" value={season} />
        <PickerField label="Franchise A" name="franchiseA" options={franchiseOptions} selected={franchiseAId} />
        <PickerField label="Franchise B" name="franchiseB" options={franchiseOptions} selected={franchiseBId} />
        <button type="submit" className={submitClass}>
          Swap Schedules
        </button>
      </form>

      {!result ? (
        <p className="text-sm text-muted">Not enough data for that pairing in {season}.</p>
      ) : (
        <>
          <p className="max-w-[760px] text-[15px] leading-[1.6] text-muted">
            <span className="display text-[11px] tracking-[0.2em] text-ink">The rule: </span>
            {result.headToHeadRule} Regular season only — playoff pairings are seeded by standings, not a fixed schedule, so there&apos;s nothing to
            swap there.
          </p>
          <div className="grid gap-6 md:grid-cols-2">
            <ScheduleSwapFranchiseCard
              option={findFranchise(franchiseOptions, result.franchiseA.franchiseId)}
              opponentOption={findFranchise(franchiseOptions, result.franchiseB.franchiseId)}
              result={result.franchiseA}
              flags={resolveFranchiseFlags(identityFlags, result.franchiseA.franchiseId)}
              identityFlags={identityFlags}
              franchiseOptions={franchiseOptions}
            />
            <ScheduleSwapFranchiseCard
              option={findFranchise(franchiseOptions, result.franchiseB.franchiseId)}
              opponentOption={findFranchise(franchiseOptions, result.franchiseA.franchiseId)}
              result={result.franchiseB}
              flags={resolveFranchiseFlags(identityFlags, result.franchiseB.franchiseId)}
              identityFlags={identityFlags}
              franchiseOptions={franchiseOptions}
            />
          </div>
        </>
      )}
    </div>
  );
}

function ScheduleSwapFranchiseCard({
  option,
  opponentOption,
  result,
  flags,
  identityFlags,
  franchiseOptions,
}: {
  option: WhatIfFranchiseOption;
  opponentOption: WhatIfFranchiseOption;
  result: ScheduleSwapFranchiseResult;
  flags: FranchiseNameFlags;
  identityFlags: IdentityFlags;
  franchiseOptions: WhatIfFranchiseOption[];
}) {
  const cardSurface = "var(--color-sheet-raised)";
  return (
    <WhatIfCard>
      <div className="flex items-baseline justify-between gap-3">
        <FranchiseName franchise={{ id: option.id, name: option.name, ...flags }} size="heading" surfaceBehind={cardSurface} />
        <span className="display text-[20px] font-bold tabular-nums text-ink">{recordLine(result.record)}</span>
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-1 text-[13px] text-muted">
        under <OpponentName franchiseOptions={franchiseOptions} identityFlags={identityFlags} franchiseId={opponentOption.id} size="inline" surfaceBehind={cardSurface} />
        {possessiveSuffix(opponentOption.name)} schedule · actual was <span className="tabular-nums">{recordLine(result.actual)}</span>
      </p>

      <p className="mt-4 text-[15px] leading-[1.55] text-ink">
        {swapVerdict(
          <FranchiseName franchise={{ id: option.id, name: option.name, ...flags }} size="inline" surfaceBehind={cardSurface} />,
          <OpponentName franchiseOptions={franchiseOptions} identityFlags={identityFlags} franchiseId={opponentOption.id} size="inline" surfaceBehind={cardSurface} />,
          result.record,
          result.actual,
        )}
      </p>

      <table className="mt-4 w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-line-sheet-strong text-left text-muted">
            <Th label="Wk" tip="Week of the regular season — Schedule Swap only ever touches the regular season." />
            <Th label="Opponent" tip="Who this franchise's SWAPPED schedule has it facing that week — not necessarily who it really played." />
            <Th label="Own" tip="This franchise's real score that week. Swapping schedules never changes what you actually scored, only who you're compared against." align="right" />
            <Th label="Opp" tip="The swapped opponent's real score that week — a real score that really happened, just paired against a different real week." align="right" />
            <Th label="Result" tip="Win, loss, or tie under the swapped pairing — Own vs. Opp, nothing hypothetical about either number." align="right" last />
          </tr>
        </thead>
        <tbody>
          {result.record.weeks.map((w) => (
            <tr key={w.week} className="border-b border-line-sheet last:border-0">
              <td className="py-1.5 pr-2 tabular-nums text-muted">{w.week}</td>
              <td className="py-1.5 pr-2">
                {w.opponentFranchiseId === null ? (
                  <span className="text-muted">bye</span>
                ) : (
                  <span className="inline-flex items-center">
                    <OpponentName franchiseOptions={franchiseOptions} identityFlags={identityFlags} franchiseId={w.opponentFranchiseId} size="row" surfaceBehind={cardSurface} />
                    {w.opponentFranchiseId === opponentOption.id ? (
                      <TipTag tone="neutral" tip="These two actually played this week — real result kept; a swap can't un-play it.">
                        H2H
                      </TipTag>
                    ) : null}
                  </span>
                )}
              </td>
              <td className="py-1.5 pr-2 text-right tabular-nums text-ink">{w.ownScore.toFixed(1)}</td>
              <td className="py-1.5 pr-2 text-right tabular-nums text-muted">{w.opponentScore === null ? "—" : w.opponentScore.toFixed(1)}</td>
              <td className={cn("py-1.5 text-right font-semibold tabular-nums", w.result === "W" ? "text-kelly" : w.result === "L" ? "text-loss" : "text-muted")}>
                {w.result ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </WhatIfCard>
  );
}

// ---------------------------------------------------------------------------
// Mode 2: Best/Worst Schedule
// ---------------------------------------------------------------------------

/**
 * Fix round 2: `nameNode`/`bestSourceNode`/`worstSourceNode` are pre-rendered <FranchiseName>/
 * <OpponentName> elements — the SAME best/worst schedule-source names already render marked in
 * this card's stat tiles one paragraph below; the verdict can't be the one place they go plain.
 * Wording is byte-identical to the pre-fix plain-string version (user-approved copy) — including
 * the literal "'s" (not the possessive() helper's ends-in-s exception; unchanged from before this
 * fix, out of scope here). Written on ONE line so JSX doesn't strip the literal spaces.
 */
function bestWorstVerdict(nameNode: ReactNode, bestSourceNode: ReactNode, best: WhatIfSeasonRecord, worstSourceNode: ReactNode, worst: WhatIfSeasonRecord, actual: WhatIfSeasonRecord): ReactNode {
  return <>{nameNode}&apos;s dream schedule belongs to {bestSourceNode}: {recordLine(best)}. The nightmare belongs to {worstSourceNode}, at {recordLine(worst)}. Real life landed at {recordLine(actual)}.</>;
}

function BestWorstSection({
  season,
  franchiseOptions,
  params,
  identityFlags,
}: {
  season: number;
  franchiseOptions: WhatIfFranchiseOption[];
  params: WhatIfSearchParams;
  identityFlags: IdentityFlags;
}) {
  const franchiseId = resolveWhatIfFranchise(params.franchise, franchiseOptions, franchiseOptions[0]!.id);
  const result = getBestWorstScheduleResult(season, franchiseId);
  const option = findFranchise(franchiseOptions, franchiseId);
  const flags = resolveFranchiseFlags(identityFlags, franchiseId);

  return (
    <div className="flex flex-col gap-8">
      <form method="get" className="flex flex-wrap items-end gap-4 border border-line-sheet bg-sheet p-5">
        <input type="hidden" name="mode" value="bestworst" />
        <input type="hidden" name="season" value={season} />
        <PickerField label="Franchise" name="franchise" options={franchiseOptions} selected={franchiseId} />
        <button type="submit" className={submitClass}>
          Run Every Schedule
        </button>
      </form>

      {!result || result.schedules.length === 0 ? (
        <p className="text-sm text-muted">Not enough other franchises in {season} to compare schedules against.</p>
      ) : (
        <BestWorstCard option={option} result={result} flags={flags} identityFlags={identityFlags} franchiseOptions={franchiseOptions} />
      )}
    </div>
  );
}

function BestWorstCard({
  option,
  result,
  flags,
  identityFlags,
  franchiseOptions,
}: {
  option: WhatIfFranchiseOption;
  result: BestWorstScheduleResult;
  flags: FranchiseNameFlags;
  identityFlags: IdentityFlags;
  franchiseOptions: WhatIfFranchiseOption[];
}) {
  const cardSurface = "var(--color-sheet-raised)";
  const statSurface = "var(--color-sheet)";
  const best = result.best!;
  const worst = result.worst!;

  return (
    <WhatIfCard>
      <FranchiseName franchise={{ id: option.id, name: option.name, ...flags }} size="heading" surfaceBehind={cardSurface} />
      <p className="mt-4 text-[15px] leading-[1.55] text-ink">
        {bestWorstVerdict(
          <FranchiseName franchise={{ id: option.id, name: option.name, ...flags }} size="inline" surfaceBehind={cardSurface} />,
          <OpponentName franchiseOptions={franchiseOptions} identityFlags={identityFlags} franchiseId={best.scheduleSourceFranchiseId} size="inline" surfaceBehind={cardSurface} />,
          best.record,
          <OpponentName franchiseOptions={franchiseOptions} identityFlags={identityFlags} franchiseId={worst.scheduleSourceFranchiseId} size="inline" surfaceBehind={cardSurface} />,
          worst.record,
          result.actual,
        )}
      </p>

      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <BestWorstStat
          label="Best case"
          sourceNode={<OpponentName franchiseOptions={franchiseOptions} identityFlags={identityFlags} franchiseId={best.scheduleSourceFranchiseId} size="inline" surfaceBehind={statSurface} />}
          record={best.record}
          tone="best"
        />
        <BestWorstStat label="Actual" sourceNode="real schedule" record={result.actual} tone="actual" />
        <BestWorstStat
          label="Worst case"
          sourceNode={<OpponentName franchiseOptions={franchiseOptions} identityFlags={identityFlags} franchiseId={worst.scheduleSourceFranchiseId} size="inline" surfaceBehind={statSurface} />}
          record={worst.record}
          tone="worst"
        />
      </div>

      <table className="mt-6 w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-line-sheet-strong text-left text-muted">
            <Th label="Under this franchise's schedule" tip="Every OTHER franchise that season, one row each — this franchise's real scores replayed against what THAT franchise actually faced week to week." />
            <Th label="Record" tip="Win-loss-tie under that schedule." align="right" />
            <Th label="PF" tip="Points scored under that schedule — usually the same total as every other row, since your own scores never change; it only drops if the schedule source had a bye you inherit." align="right" last />
          </tr>
        </thead>
        <tbody>
          {result.schedules.map((s) => (
            <BestWorstRow
              key={s.scheduleSourceFranchiseId}
              entry={s}
              franchiseOptions={franchiseOptions}
              identityFlags={identityFlags}
              surfaceBehind={cardSurface}
              best={best}
              worst={worst}
            />
          ))}
        </tbody>
      </table>
    </WhatIfCard>
  );
}

function BestWorstStat({ label, sourceNode, record, tone }: { label: string; sourceNode: ReactNode; record: WhatIfSeasonRecord; tone: "best" | "worst" | "actual" }) {
  return (
    <div className="border border-line-sheet-strong bg-sheet p-3">
      <p className="display text-[10px] tracking-[0.16em] text-muted">{label}</p>
      <p className={cn("display text-[19px] font-bold tabular-nums", tone === "best" ? "text-kelly" : tone === "worst" ? "text-loss" : "text-ink")}>
        {recordLine(record)}
      </p>
      <p className="truncate text-[12px] text-muted">{sourceNode}</p>
    </div>
  );
}

function BestWorstRow({
  entry,
  franchiseOptions,
  identityFlags,
  surfaceBehind,
  best,
  worst,
}: {
  entry: BestWorstScheduleEntry;
  franchiseOptions: WhatIfFranchiseOption[];
  identityFlags: IdentityFlags;
  surfaceBehind: string;
  best: BestWorstScheduleEntry;
  worst: BestWorstScheduleEntry;
}) {
  const isBest = entry.scheduleSourceFranchiseId === best.scheduleSourceFranchiseId;
  const isWorst = entry.scheduleSourceFranchiseId === worst.scheduleSourceFranchiseId;
  return (
    <tr className="border-b border-line-sheet last:border-0">
      <td className="py-1.5 pr-2 text-ink">
        <span className="inline-flex items-center">
          <OpponentName franchiseOptions={franchiseOptions} identityFlags={identityFlags} franchiseId={entry.scheduleSourceFranchiseId} size="row" surfaceBehind={surfaceBehind} />
          {isBest ? (
            <TipTag tone="best" tip="The friendliest schedule this franchise could have drawn — ranked by win %, then wins, then points for.">
              BEST
            </TipTag>
          ) : null}
          {isWorst ? (
            <TipTag tone="worst" tip="The cruelest schedule this franchise could have drawn — same ranking, the bottom of it.">
              WORST
            </TipTag>
          ) : null}
        </span>
      </td>
      <td className="py-1.5 pr-2 text-right tabular-nums text-ink">{recordLine(entry.record)}</td>
      <td className="py-1.5 text-right tabular-nums text-muted">{entry.record.pointsFor.toFixed(1)}</td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Mode 3: Perfect Lineups
// ---------------------------------------------------------------------------

/**
 * Fix round 2: same pattern as swapVerdict/bestWorstVerdict — `nameNode` is the SAME franchise
 * already marked in this card's header immediately above; the verdict can't be the one place it
 * goes plain. Wording is byte-identical to the pre-fix plain-string version (user-approved copy).
 * Written on ONE line so JSX doesn't strip the literal spaces.
 */
function lineupVerdict(nameNode: ReactNode, record: WhatIfSeasonRecord, actualWins: number, actualLosses: number, actualTies: number): ReactNode {
  const deltaWins = record.wins - actualWins;
  const newLine = recordLine(record);
  const realLine = formatWLT(actualWins, actualLosses, actualTies);
  if (deltaWins > 0) return <>Every optimal lineup, every week: {nameNode} finishes {newLine} instead of the real {realLine} — the bench cost {deltaWins} win{deltaWins === 1 ? "" : "s"}.</>;
  if (deltaWins < 0) return <>Even with the optimal lineup every week, {nameNode} finishes {newLine} against a real {realLine} — the bench wasn&apos;t the problem here.</>;
  return <>Optimal lineup every week still lands {nameNode} at {newLine}, same as reality. The bench wasn&apos;t the issue this year.</>;
}

function PerfectLineupSection({
  season,
  franchiseOptions,
  params,
  identityFlags,
}: {
  season: number;
  franchiseOptions: WhatIfFranchiseOption[];
  params: WhatIfSearchParams;
  identityFlags: IdentityFlags;
}) {
  const franchiseId = resolveWhatIfFranchise(params.franchise, franchiseOptions, franchiseOptions[0]!.id);
  const result = getOptimalLineupSeasonResult(season, franchiseId);
  const option = findFranchise(franchiseOptions, franchiseId);
  const flags = resolveFranchiseFlags(identityFlags, franchiseId);

  return (
    <div className="flex flex-col gap-8">
      <form method="get" className="flex flex-wrap items-end gap-4 border border-line-sheet bg-sheet p-5">
        <input type="hidden" name="mode" value="lineup" />
        <input type="hidden" name="season" value={season} />
        <PickerField label="Franchise" name="franchise" options={franchiseOptions} selected={franchiseId} />
        <button type="submit" className={submitClass}>
          Start The Bench
        </button>
      </form>

      {!result ? (
        <p className="text-sm text-muted">No decided games for that franchise in {season}.</p>
      ) : !result.available ? (
        <div className="border border-line-sheet bg-sheet p-5">
          <FranchiseName franchise={{ id: option.id, name: option.name, ...flags }} size="heading" surfaceBehind="var(--color-sheet)" />
          <p className="mt-3 text-[15px] text-muted">{result.unavailableReason}</p>
        </div>
      ) : (
        <PerfectLineupCard season={season} option={option} result={result} flags={flags} identityFlags={identityFlags} franchiseOptions={franchiseOptions} />
      )}
    </div>
  );
}

function PerfectLineupCard({
  season,
  option,
  result,
  flags,
  identityFlags,
  franchiseOptions,
}: {
  season: number;
  option: WhatIfFranchiseOption;
  result: OptimalLineupSeasonResult;
  flags: FranchiseNameFlags;
  identityFlags: IdentityFlags;
  franchiseOptions: WhatIfFranchiseOption[];
}) {
  const cardSurface = "var(--color-sheet-raised)";
  const record = result.record!;
  const realRow = getStandingsReal(season).find((r) => r.franchiseId === option.id);
  const actualWins = realRow?.wins ?? 0;
  const actualLosses = realRow?.losses ?? 0;
  const actualTies = realRow?.ties ?? 0;

  return (
    <WhatIfCard>
      <div className="flex items-baseline justify-between gap-3">
        <FranchiseName franchise={{ id: option.id, name: option.name, ...flags }} size="heading" surfaceBehind={cardSurface} />
        <span className="display text-[20px] font-bold tabular-nums text-ink">{recordLine(record)}</span>
      </div>
      <p className="mt-1 text-[13px] text-muted">
        starting the optimal lineup every week · actual was <span className="tabular-nums">{formatWLT(actualWins, actualLosses, actualTies)}</span>
      </p>

      <p className="mt-4 text-[15px] leading-[1.55] text-ink">
        {lineupVerdict(
          <FranchiseName franchise={{ id: option.id, name: option.name, ...flags }} size="inline" surfaceBehind={cardSurface} />,
          record,
          actualWins,
          actualLosses,
          actualTies,
        )}
      </p>

      <table className="mt-4 w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-line-sheet-strong text-left text-muted">
            <Th label="Wk" tip="Week of the season — includes playoffs, since Perfect Lineups never touches who the opponent was, only the lineup." />
            <Th label="Opponent" tip="Who this franchise actually played that week — the real schedule, unchanged." />
            <Th label="Optimal" tip="The highest score this franchise's actual roster could have posted that week, if every start had been the best available one." align="right" />
            <Th label="Opp (actual)" tip="The opponent's real score — nobody else gets the optimal-lineup treatment, only you." align="right" />
            <Th label="Result" tip="Win, loss, or tie: the optimal score vs. the opponent's real score." align="right" last />
          </tr>
        </thead>
        <tbody>
          {record.weeks.map((w) => (
            <tr key={w.week} className="border-b border-line-sheet last:border-0">
              <td className="py-1.5 pr-2 tabular-nums text-muted">{w.week}</td>
              <td className="py-1.5 pr-2 text-ink">
                {w.opponentFranchiseId === null ? (
                  <span className="text-muted">bye</span>
                ) : (
                  <OpponentName franchiseOptions={franchiseOptions} identityFlags={identityFlags} franchiseId={w.opponentFranchiseId} size="row" surfaceBehind={cardSurface} />
                )}
              </td>
              <td className="py-1.5 pr-2 text-right tabular-nums text-ink">{w.ownScore.toFixed(1)}</td>
              <td className="py-1.5 pr-2 text-right tabular-nums text-muted">{w.opponentScore === null ? "—" : w.opponentScore.toFixed(1)}</td>
              <td className={cn("py-1.5 text-right font-semibold tabular-nums", w.result === "W" ? "text-kelly" : w.result === "L" ? "text-loss" : "text-muted")}>
                {w.result ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </WhatIfCard>
  );
}
