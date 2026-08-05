import Link from "next/link";
import { AnimatedNumber } from "@/components/broadcast/AnimatedNumber";
import type { DraftCountdown } from "@/server/queries/home";
import { formatDraftDateFull } from "@/server/queries/homepage";
import type { YourWeekCard as YourWeekCardData } from "@/server/queries/homepage";

/**
 * Rail's season-dependent card (README "2. Home" — rail): draft countdown offseason, "your week"
 * in-season. Two distinct components (not one branching on a prop) — the offseason card renders
 * unconditionally from getDraftCountdown(); the in-season card's data can itself be null (no
 * signed-in franchise, or a bye week), which the caller (page.tsx) already branches on before
 * rendering either.
 */
export function DraftCountdownCard({ countdown }: { countdown: DraftCountdown }) {
  const days = Math.max(countdown.daysRemaining, 0);
  return (
    <div className="border-b border-line bg-chrome px-6 py-6 md:px-7">
      <div className="display text-[11px] tracking-[0.22em] text-muted-on-chrome">Draft Night</div>
      <div className="mt-1.5 flex items-baseline gap-2.5">
        <AnimatedNumber value={days} className="display text-[40px] leading-none text-kelly-bright md:text-[56px]" />
        <span className="display text-lg tracking-[0.08em] text-muted-on-chrome md:text-xl">day{days === 1 ? "" : "s"} out</span>
      </div>
      <div className="mt-1.5 text-[13px] text-muted-on-chrome">{formatDraftDateFull(countdown.targetDateIso)}</div>
    </div>
  );
}

export function YourWeekCard({ data }: { data: YourWeekCardData }) {
  const bye = data.opponentFranchiseId === null;

  return (
    <div className="border-b border-line bg-chrome px-6 py-6 md:px-7">
      <div className="display text-[11px] tracking-[0.22em] text-muted-on-chrome">
        Your Week{data.week ? ` · Wk ${data.week}` : ""}
      </div>
      {bye ? (
        <p className="mt-2 text-sm text-muted-on-chrome">Bye week — no matchup.</p>
      ) : data.isFinal ? (
        <>
          <div className="display mt-1.5 text-[40px] leading-none text-ink-on-chrome md:text-[56px]">
            {data.myScore !== null ? data.myScore.toFixed(1) : "—"}
            <span className="text-lg text-muted-on-chrome"> – {data.oppScore !== null ? data.oppScore.toFixed(1) : "—"}</span>
          </div>
          <div className="mt-1.5 text-[13px] text-muted-on-chrome">Final vs {data.opponentName}</div>
        </>
      ) : (
        <>
          <ProjectedMargin myProjected={data.myProjected} oppProjected={data.oppProjected} />
          <div className="mt-1.5 text-[13px] text-muted-on-chrome">
            vs {data.opponentName}
            {data.myScore !== null || data.oppScore !== null
              ? ` · ${data.myScore?.toFixed(1) ?? "—"} – ${data.oppScore?.toFixed(1) ?? "—"} so far`
              : " · not yet started"}
          </div>
        </>
      )}
      <Link href="/matchups" className="display mt-3 inline-block text-[13px] tracking-[0.14em] text-kelly-bright">
        This week&apos;s matchups →
      </Link>
    </div>
  );
}

function ProjectedMargin({ myProjected, oppProjected }: { myProjected: number | null; oppProjected: number | null }) {
  if (myProjected === null || oppProjected === null) {
    return <p className="mt-2 text-sm text-muted-on-chrome">Projections not yet available.</p>;
  }
  const diff = myProjected - oppProjected;
  const sign = diff > 0 ? "+" : diff < 0 ? "−" : "";
  const color = diff > 0 ? "text-kelly-bright" : diff < 0 ? "text-live" : "text-ink-on-chrome";
  return (
    <div className={`display mt-1.5 text-[40px] leading-none md:text-[56px] ${color}`}>
      {sign}
      {Math.abs(diff).toFixed(1)}
      <span className="text-lg text-muted-on-chrome"> projected</span>
    </div>
  );
}
