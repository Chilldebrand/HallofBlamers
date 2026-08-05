import { notFound } from "next/navigation";
import { PageHeader } from "@/components/broadcast/PageHeader";
import { RecapMarkdownView } from "@/features/recaps/markdown-view";
import { getPublishedRecap } from "@/server/queries/recaps";
import { RECAP_STYLES } from "@/server/ai/styles";

export default async function PublicRecapPage({ params }: { params: Promise<{ year: string; week: string }> }) {
  const { year: yearParam, week: weekParam } = await params;
  const season = Number(yearParam);
  const week = Number(weekParam);
  if (!Number.isInteger(season) || !Number.isInteger(week)) notFound();

  // Published only — an unpublished/draft/edited row (or no row at all) 404s. `markdownFinal` is
  // the frozen, commissioner-approved text; never fall back to `markdownDraft` here.
  const recap = getPublishedRecap(season, week);
  if (!recap || !recap.markdownFinal) notFound();

  const styleLabel = RECAP_STYLES.find((s) => s.id === recap.style)?.label ?? recap.style;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader eyebrow={`${season} · Week ${week} · ${styleLabel}`} title="Weekly Recap" />
      <div className="border border-line-sheet bg-sheet p-6 sm:p-8">
        <RecapMarkdownView markdown={recap.markdownFinal} />
      </div>
    </div>
  );
}
