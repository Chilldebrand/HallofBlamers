import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/broadcast/PageHeader";
import { StatChip } from "@/components/broadcast/StatChip";
import { FranchiseName, type FranchiseNameFlags } from "@/components/league/FranchiseName";
import { formatSigned, formatWLT } from "@/components/history/format";
import { getDb } from "@/server/db/client";
import { requireManager } from "@/server/auth/guard";
import { getIdentityFlags, resolveFranchiseFlags } from "@/server/queries/identity";
import { computeAdvantage, getH2HPairDetail } from "@/server/queries/h2h";

export default async function H2HPairPage({ params }: { params: Promise<{ a: string; b: string }> }) {
  const { a, b } = await params;
  const idA = Number(a);
  const idB = Number(b);
  if (!Number.isInteger(idA) || !Number.isInteger(idB)) notFound();

  const pair = getH2HPairDetail(idA, idB);
  if (!pair) notFound();

  const manager = await requireManager();
  const identityFlags = getIdentityFlags(getDb(), manager.id);
  const flagsFor = (franchiseId: number): FranchiseNameFlags => resolveFranchiseFlags(identityFlags, franchiseId);

  const totalAWins = pair.regW + pair.playoffW;
  const totalALosses = pair.regL + pair.playoffL;
  const totalTies = pair.regT + pair.playoffT;

  // Fix round 1, I2: franchise_a is just min(franchiseId) — it is NOT necessarily the side with
  // more wins. "X leads" must be computed from the actual W/L, not attributed to franchise_a
  // unconditionally (real bug caught live: "Two Time Timmy leads 7-14" — franchise_a trailing,
  // rendered as if leading).
  const advantage = computeAdvantage(totalAWins, totalALosses);
  const leader = advantage === "leading" ? pair.franchiseA : advantage === "trailing" ? pair.franchiseB : null;
  const trailer = advantage === "leading" ? pair.franchiseB : advantage === "trailing" ? pair.franchiseA : null;
  const leaderWins = advantage === "trailing" ? totalALosses : totalAWins;
  const leaderLosses = advantage === "trailing" ? totalAWins : totalALosses;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Head-to-Head"
        title={`${pair.franchiseA.name} vs. ${pair.franchiseB.name}`}
        right={
          <Link href="/h2h" className="display text-[12px] tracking-[0.16em] text-muted hover:text-ink">
            &larr; Back to Grid
          </Link>
        }
      />

      <section className="border border-line-sheet bg-sheet p-6">
        <div className="border-l-2 border-line-sheet-strong py-1 pl-3">
          <p className="display text-[11px] tracking-[0.18em] text-muted">All-Time</p>
          <p className="flex flex-wrap items-center gap-x-1.5 text-[17px] text-ink">
            {leader && trailer ? (
              <>
                <Link href={`/franchises/${leader.id}`} className="hover:underline">
                  <FranchiseName franchise={{ id: leader.id, name: leader.name, ...flagsFor(leader.id) }} size="inline" surfaceBehind="var(--color-sheet)" />
                </Link>
                leads <span className="tabular-nums">{formatWLT(leaderWins, leaderLosses, totalTies)}</span> vs.
                <Link href={`/franchises/${trailer.id}`} className="hover:underline">
                  <FranchiseName franchise={{ id: trailer.id, name: trailer.name, ...flagsFor(trailer.id) }} size="inline" surfaceBehind="var(--color-sheet)" />
                </Link>
              </>
            ) : (
              <>
                Series tied{" "}
                <span className="tabular-nums">
                  {totalAWins}-{totalALosses}
                  {totalTies > 0 ? `-${totalTies}` : ""}
                </span>
              </>
            )}
          </p>
        </div>
        <div className="mt-5 flex flex-wrap gap-x-8 gap-y-3">
          <StatChip label="Regular Season" value={formatWLT(pair.regW, pair.regL, pair.regT)} />
          <StatChip label="Playoffs" value={formatWLT(pair.playoffW, pair.playoffL, pair.playoffT)} />
          <StatChip label={`${pair.franchiseA.name} Points`} value={pair.pointsA.toFixed(1)} />
          <StatChip label={`${pair.franchiseB.name} Points`} value={pair.pointsB.toFixed(1)} />
          <StatChip label={`Avg Margin (${pair.franchiseA.name})`} value={formatSigned(pair.avgMargin)} />
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <PairFact
          eyebrow="Current Streak"
          statement={
            pair.streak ? (
              <>
                <FranchiseName franchise={{ id: pair.streak.holderId, name: pair.streak.holderName, ...flagsFor(pair.streak.holderId) }} size="inline" surfaceBehind="var(--color-sheet)" /> —{" "}
                {pair.streak.len} straight
              </>
            ) : (
              "No streak on record."
            )
          }
        />
        <PairFact eyebrow="Last Meeting" statement={pair.lastMeeting ? `${pair.lastMeeting.season}, Week ${pair.lastMeeting.week}` : "Not on record."} />
        <PairFact
          eyebrow="Largest Win"
          statement={
            pair.largestWin ? (
              <>
                <FranchiseName
                  franchise={{ id: pair.largestWin.winnerFranchiseId, name: pair.largestWin.winnerName, ...flagsFor(pair.largestWin.winnerFranchiseId) }}
                  size="inline"
                  surfaceBehind="var(--color-sheet)"
                />{" "}
                by {pair.largestWin.value.toFixed(1)} — {pair.largestWin.season} Wk {pair.largestWin.week}
              </>
            ) : (
              "Not on record."
            )
          }
        />
        <PairFact eyebrow="Closest Game" statement={pair.closestGame ? `Margin of ${pair.closestGame.margin.toFixed(1)} — ${pair.closestGame.season} Wk ${pair.closestGame.week}` : "Not on record."} />
      </section>
    </div>
  );
}

function PairFact({ eyebrow, statement }: { eyebrow: string; statement: React.ReactNode }) {
  return (
    <div className="border border-line-sheet bg-sheet p-5">
      <p className="display text-[11px] tracking-[0.18em] text-muted">{eyebrow}</p>
      <p className="mt-1 text-[15px] text-ink">{statement}</p>
    </div>
  );
}
