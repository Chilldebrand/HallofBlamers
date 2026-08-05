import Link from "next/link";
import { PageHeader } from "@/components/broadcast/PageHeader";
import { cn } from "@/components/ui/cn";
import { getPublishedRecapSeasons, getPublishedRecapsForSeason } from "@/server/queries/recaps";
import { RECAP_STYLES } from "@/server/ai/styles";

function styleLabel(styleId: string): string {
  return RECAP_STYLES.find((s) => s.id === styleId)?.label ?? styleId;
}

export default async function RecapsIndexPage({ searchParams }: { searchParams: Promise<{ season?: string }> }) {
  const params = await searchParams;
  const seasons = getPublishedRecapSeasons();
  const activeSeason = seasons.length > 0 ? Number(params.season) || seasons[0]! : null;
  const recaps = activeSeason !== null ? getPublishedRecapsForSeason(activeSeason) : [];

  return (
    <div className="flex flex-col gap-8">
      <PageHeader eyebrow="League Media" title="Weekly Recaps" />

      {seasons.length === 0 ? (
        <p className="border border-line-sheet bg-sheet p-6 text-sm text-muted">No recaps have been published yet.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {seasons.map((s) => (
              <Link
                key={s}
                href={`/recaps?season=${s}`}
                className={cn(
                  "display rounded-full border px-3.5 py-1.5 text-[13px] tracking-[0.1em]",
                  s === activeSeason ? "border-kelly-deep bg-kelly-deep font-bold text-sheet" : "border-line-sheet-strong text-muted hover:text-ink",
                )}
              >
                {s}
              </Link>
            ))}
          </div>

          <div className="flex flex-col gap-3">
            {recaps.map((r) => (
              <Link key={r.id} href={`/recaps/${r.season}/${r.week}`} className="flex items-center justify-between gap-4 border border-line-sheet bg-sheet px-5 py-4 transition-colors hover:border-ink">
                <span className="display text-[16px] uppercase text-ink">Week {r.week}</span>
                <span className="display text-[11px] tracking-[0.16em] text-muted">{styleLabel(r.style)}</span>
              </Link>
            ))}
            {recaps.length === 0 ? <p className="border border-line-sheet bg-sheet p-6 text-sm text-muted">No recaps published for {activeSeason} yet.</p> : null}
          </div>
        </>
      )}
    </div>
  );
}
