import { notFound } from "next/navigation";
import { Button, Notice } from "@/components/broadcast/FormControls";
import { PageHeader } from "@/components/broadcast/PageHeader";
import { SectionLabel } from "@/components/broadcast/SectionLabel";
import { requireCommissioner } from "@/server/auth/guard";
import { generateRecapAction, publishRecapAction, saveRecapEditAction, switchToFallbackAction } from "@/features/recaps/actions";
import { RecapMarkdownView } from "@/features/recaps/markdown-view";
import { getRecapById } from "@/features/recaps/queries";
import type { WeekFacts } from "@/server/ai/facts";
import { RECAP_STYLES } from "@/server/ai/styles";
import { isCompleteWeekFacts, validateRecap } from "@/server/ai/validate";

export default async function AdminRecapDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  await requireCommissioner();

  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isInteger(id)) notFound();

  const recap = getRecapById(id);
  if (!recap) notFound();

  const { error, success } = await searchParams;
  const facts = recap.factsJson as WeekFacts;
  const styleLabel = RECAP_STYLES.find((s) => s.id === recap.style)?.label ?? recap.style;
  const draft = recap.markdownDraft ?? "";

  // Fix round 1, I2: `validateRecap`'s own collectors are defensive against a partial/malformed
  // `factsJson` and never throw — but fix round 2 closed the gap that left open: a defensive
  // collector returns ZERO warnings for a `{meta}`-only row not because the draft was checked and
  // found clean, but because there was nothing to check. `isCompleteWeekFacts` is checked FIRST so
  // that case renders the honest "warnings unavailable" notice instead of a false "no warnings"
  // all-clear. The try/catch stays as a second net against any OTHER future failure inside
  // validation ever 500ing the whole page instead of degrading to a visible notice.
  let warnings: ReturnType<typeof validateRecap> = [];
  let warningsUnavailable = false;
  if (draft) {
    if (!isCompleteWeekFacts(facts)) {
      warningsUnavailable = true;
    } else {
      try {
        warnings = validateRecap(draft, facts);
      } catch {
        warningsUnavailable = true;
      }
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader eyebrow={`${recap.season} · Week ${recap.week} · ${styleLabel}`} title={`Recap #${recap.id}`} />

      {error ? <Notice tone="live">{error}</Notice> : null}
      {success === "saved" ? <Notice tone="kelly">Edits saved.</Notice> : null}
      {success === "published" ? <Notice tone="ink">This recap is now live on the public recap page.</Notice> : null}

      <section className="flex flex-wrap items-center gap-4 border border-line-sheet bg-sheet p-4 text-xs text-muted">
        <span>
          Status: <span className="text-ink">{recap.status}</span>
        </span>
        <span>
          Model: <span className="text-ink">{recap.model ?? "fallback (no API call)"}</span>
        </span>
        {recap.tokensIn !== null && recap.tokensOut !== null ? (
          <span>
            Tokens: <span className="tabular-nums text-ink">{recap.tokensIn} in / {recap.tokensOut} out</span>
          </span>
        ) : null}
        {recap.costUsd !== null ? (
          <span>
            Cost: <span className="tabular-nums text-ink">${recap.costUsd.toFixed(4)}</span>
          </span>
        ) : null}
      </section>

      {warningsUnavailable ? (
        <Notice tone="ink">Warnings unavailable — this recap&apos;s facts couldn&apos;t be checked. Review the draft manually before publishing.</Notice>
      ) : warnings.length > 0 ? (
        <section className="flex flex-col gap-4">
          <SectionLabel>Validation Warnings ({warnings.length})</SectionLabel>
          {/* Fix round 1, finding 3: this was gold (border-l-gold-fill + gold-ink badges) —
              gold is reserved for the champion/belt identity system (README "Identity system"),
              not a generic "pay attention" flag. Retoned to the same neutral `Notice` treatment
              already used for "Warnings unavailable" just above. */}
          <Notice tone="ink">
            <ul className="flex flex-col gap-2">
              {warnings.map((w, i) => (
                <li key={i} className="text-sm text-ink">
                  <span className="display mr-2 rounded-full border border-line-sheet-strong px-2 py-0.5 text-[10px] tracking-wide text-muted">{w.type}</span>
                  {w.detail}
                </li>
              ))}
            </ul>
          </Notice>
        </section>
      ) : (
        <Notice tone="kelly">No warnings — every number and name traced back to the facts.</Notice>
      )}

      <section className="flex flex-col gap-4">
        <SectionLabel>Rendered Preview</SectionLabel>
        <div className="border border-line-sheet bg-sheet p-6">{draft ? <RecapMarkdownView markdown={draft} /> : <p className="text-sm text-muted">No draft content yet.</p>}</div>
      </section>

      <section className="flex flex-col gap-4">
        <SectionLabel>Edit Markdown</SectionLabel>
        <form action={saveRecapEditAction} className="flex flex-col gap-3">
          <input type="hidden" name="recapId" value={recap.id} />
          <textarea name="markdown" defaultValue={draft} rows={20} className="w-full border border-line-sheet bg-sheet p-4 font-mono text-xs text-ink" />
          <div>
            <Button>Save Edits</Button>
          </div>
        </form>
      </section>

      <section className="flex flex-col gap-4">
        <SectionLabel>Actions</SectionLabel>
        <div className="flex flex-wrap gap-3">
          <form action={generateRecapAction}>
            <input type="hidden" name="season" value={recap.season} />
            <input type="hidden" name="week" value={recap.week} />
            <input type="hidden" name="styleId" value={recap.style} />
            <Button>Regenerate (new draft)</Button>
          </form>
          <form action={switchToFallbackAction}>
            <input type="hidden" name="recapId" value={recap.id} />
            <Button>Switch to Fallback (new draft)</Button>
          </form>
          <form action={publishRecapAction}>
            <input type="hidden" name="recapId" value={recap.id} />
            {/* Fix round 1, finding 3: retoned from gold (reserved for champion/belt) to kelly —
                the site's existing "positive/confirmed action" color (Notice tone="kelly" already
                marks "Edits saved"/"No warnings" the same way), not a new convention. */}
            <button
              type="submit"
              disabled={!draft}
              className="display border border-kelly px-4 py-2 text-xs tracking-[0.12em] text-kelly hover:border-kelly-deep disabled:cursor-not-allowed disabled:opacity-40"
            >
              Publish
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
