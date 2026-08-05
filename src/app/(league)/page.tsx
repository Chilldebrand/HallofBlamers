import { BeltCard } from "@/components/home/BeltCard";
import { LeadColumn } from "@/components/home/LeadColumn";
import { PowerLadder } from "@/components/home/PowerLadder";
import { RecordStrip } from "@/components/home/RecordStrip";
import { InSeasonScoreboardBand, OffseasonScoreboardBand } from "@/components/home/ScoreboardBand";
import { DraftCountdownCard, YourWeekCard } from "@/components/home/SeasonCard";
import { requireManager } from "@/server/auth/guard";
import { getCurrentReignDetail } from "@/server/queries/belt";
import { getDb } from "@/server/db/client";
import { getDraftCountdown, getLastTimeOut } from "@/server/queries/home";
import {
  getInSeasonLeadCopy,
  getInSeasonScoreboard,
  getOffseasonLeadCopy,
  getOffseasonScoreboard,
  getPowerLadder,
  getRecordStrip,
  getYourWeekCard,
} from "@/server/queries/homepage";
import { getIdentityFlags } from "@/server/queries/identity";
import { getLatestPublishedRecap } from "@/server/queries/recaps";
import { getSeasonOptions } from "@/server/queries/standings";
import { computeSeasonPhase } from "@/server/queries/ticker";

/**
 * Home (docs/design/redesign-2026-08/README.md, "2. Home") — scoreboard band, lead column + rail,
 * record strip. Season-state-driven throughout via computeSeasonPhase (the same signal the shell
 * ticker already uses), never a manual flag. The outer wrapper cancels (league)/layout.tsx's
 * `<main>` padding on all four sides so the chrome scoreboard band and record strip can bleed
 * edge-to-edge of the content sheet, matching the mockup — the lead column's own padding
 * (LeadColumn.tsx) reintroduces the inset just for its text, same as every rail card's own
 * internal padding.
 */
export default async function HomePage() {
  const manager = await requireManager();
  const flags = getIdentityFlags(getDb(), manager.id);
  const phase = computeSeasonPhase(getSeasonOptions());

  const reign = getCurrentReignDetail();
  const ladder = getPowerLadder(8);
  const recordCells = getRecordStrip();
  const latestRecap = getLatestPublishedRecap();
  const lastTimeOut = getLastTimeOut();

  return (
    <div className="-mx-5 -mt-5 -mb-8 flex flex-col sm:-mx-6 md:-mx-11 md:-mt-[34px] md:-mb-13">
      {phase === "offseason" ? (
        <OffseasonBand flags={flags} />
      ) : (
        <InSeasonScoreboardBandSection viewerFranchiseId={flags.viewerFranchiseId} flags={flags} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px]">
        <div className="border-b border-line-sheet bg-sheet lg:border-r lg:border-b-0">
          <LeadColumn
            copy={phase === "offseason" ? getOffseasonLeadCopy() : getInSeasonLeadCopy()}
            latestRecap={latestRecap}
            lastTimeOut={lastTimeOut}
            flags={flags}
          />
        </div>
        <div className="flex flex-col">
          <BeltCard reign={reign} flags={flags} />
          {phase === "offseason" ? (
            <DraftCountdownCard countdown={getDraftCountdown()} />
          ) : (
            <InSeasonRailCard viewerFranchiseId={flags.viewerFranchiseId} />
          )}
          <PowerLadder ladder={ladder} flags={flags} />
        </div>
      </div>

      <RecordStrip cells={recordCells} />
    </div>
  );
}

function OffseasonBand({ flags }: { flags: ReturnType<typeof getIdentityFlags> }) {
  const data = getOffseasonScoreboard();
  if (!data) return null;
  return <OffseasonScoreboardBand data={data} flags={flags} />;
}

function InSeasonScoreboardBandSection({
  viewerFranchiseId,
  flags,
}: {
  viewerFranchiseId: number | null;
  flags: ReturnType<typeof getIdentityFlags>;
}) {
  const data = getInSeasonScoreboard(viewerFranchiseId);
  if (!data) return null;
  return <InSeasonScoreboardBand data={data} flags={flags} />;
}

function InSeasonRailCard({ viewerFranchiseId }: { viewerFranchiseId: number | null }) {
  const data = getYourWeekCard(viewerFranchiseId);
  if (!data) return null;
  return <YourWeekCard data={data} />;
}
