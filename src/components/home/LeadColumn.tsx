import Link from "next/link";
import { FranchiseName, type FranchiseNameFranchise } from "@/components/league/FranchiseName";
import type { LastTimeOut } from "@/server/queries/home";
import type { LeadCopy } from "@/server/queries/homepage";
import type { IdentityFlags } from "@/server/queries/identity";
import { resolveFranchiseFlags } from "@/server/queries/identity";
import type { PublishedRecapSummary } from "@/server/queries/recaps";

export interface LeadColumnProps {
  copy: LeadCopy;
  latestRecap: PublishedRecapSummary | null;
  lastTimeOut: LastTimeOut | null;
  flags: IdentityFlags;
}

/**
 * Home's lead column (README "2. Home" — lead column). Headline/deck/eyebrow are the ONE tasteful
 * default composition the brief scopes this task to (server-derived from real state; the
 * commissioner-notes/editorial override is a later task). The three secondary stories are fed by
 * the most recent completed week's top context notes (getLastTimeOut) — the same query the
 * previous "Last Time Out" section used, and the cleanest existing real-data source for
 * "recent, ranked, short editorial statements" the brief asks for; noted in the task report.
 */
export function LeadColumn({ copy, latestRecap, lastTimeOut, flags }: LeadColumnProps) {
  return (
    <div className="p-5 sm:p-6 md:p-11">
      <div className="display text-[13px] tracking-[0.26em] text-kelly">{copy.eyebrow}</div>
      <h1 className="display mt-4 text-[46px] leading-[0.92] text-balance text-kelly-deep md:text-hero md:tracking-hero">{copy.headline}</h1>
      <p className="mt-3 max-w-[760px] text-base text-muted md:mt-5 md:text-xl md:leading-[1.5]">{copy.deck}</p>

      <div
        className="mt-4 flex h-[200px] items-end border border-line-sheet p-3.5 md:mt-8 md:h-[400px] md:p-5"
        style={{
          background: "repeating-linear-gradient(135deg, var(--color-line-sheet-soft) 0 12px, var(--color-sheet-raised) 12px 24px)",
        }}
      >
        <span className="font-mono text-[10px] tracking-[0.08em] text-muted md:text-xs">[ IMAGE SLOT — trophy / draft-night photo · 16:9 ]</span>
      </div>

      <div className="mt-4 flex gap-6 border-t border-line-sheet pt-4 md:mt-[22px] md:gap-10 md:pt-[18px]">
        <span className="display text-[13px] tracking-[0.16em] text-muted md:text-sm">From the Commissioner&apos;s Desk</span>
        {latestRecap ? (
          <Link href={`/recaps/${latestRecap.season}/${latestRecap.week}`} className="display text-[13px] tracking-[0.16em] text-kelly md:text-sm">
            Read the full recap →
          </Link>
        ) : (
          <span className="display text-[13px] tracking-[0.16em] text-muted/70 md:text-sm">No recap published yet</span>
        )}
      </div>

      {lastTimeOut && lastTimeOut.notes.length > 0 ? (
        <div className="mt-6 grid gap-6 border-t border-line-sheet pt-6 sm:grid-cols-3 md:mt-11 md:gap-8 md:pt-8">
          {lastTimeOut.notes.map((note) => (
            <div key={note.ruleId + (note.franchiseId ?? "league")}>
              {note.franchiseId !== null && note.franchiseName ? (
                <FranchiseName
                  franchise={nameFranchise(note.franchiseId, note.franchiseName, flags)}
                  size="inline"
                  surfaceBehind="var(--color-sheet)"
                  className="display text-[11px] tracking-[0.2em] text-muted"
                />
              ) : (
                <div className="display text-[11px] tracking-[0.2em] text-muted">League</div>
              )}
              <div className="display mt-2 text-[26px] leading-[1.05] md:text-[30px]">{note.renderedText}</div>
              <div className="mt-2.5 text-sm leading-[1.55] text-muted">
                Week {lastTimeOut.week}, {lastTimeOut.season} season.
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function nameFranchise(id: number, name: string, flags: IdentityFlags): FranchiseNameFranchise {
  return { id, name, ...resolveFranchiseFlags(flags, id) };
}
