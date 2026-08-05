import Link from "next/link";
import { Button, Notice } from "@/components/broadcast/FormControls";
import { PageHeader } from "@/components/broadcast/PageHeader";
import { SectionLabel } from "@/components/broadcast/SectionLabel";
import { requireCommissioner } from "@/server/auth/guard";
import { saveStyleGuideTextAction, saveVoiceNotesAction, updateWritingStyleAction } from "@/features/recaps/voice-actions";
import { getVoiceAdminState } from "@/features/recaps/queries";

/**
 * Task 16 — the recap writer's voice-learning surface: manual notes (always used), the learned
 * style guide (extracted from revisions, editable/clearable), and the evidence count behind it.
 * Commissioner-only mutation surface — gated here directly, same rule as every other admin/recaps
 * page (see src/features/recaps/actions.ts's docstring for why the (league) layout check alone
 * isn't sufficient).
 */
export default async function AdminRecapVoicePage({ searchParams }: { searchParams: Promise<{ error?: string; success?: string; count?: string }> }) {
  await requireCommissioner();

  const { error, success, count } = await searchParams;
  const { manualNotes, activeGuide, exemplarCount } = getVoiceAdminState();
  const guideText = activeGuide?.guideText ?? "";
  const evidenceCount = activeGuide?.exemplarCount ?? 0;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Commissioner"
        title="Writing Style"
        right={
          <Link href="/admin/recaps" className="display border border-line-sheet-strong px-4 py-2 text-xs tracking-[0.12em] text-ink hover:border-ink">
            Back to Recaps
          </Link>
        }
      />

      {error ? <Notice tone="live">{error}</Notice> : null}
      {success === "notes_saved" ? <Notice tone="kelly">Voice notes saved.</Notice> : null}
      {success === "guide_saved" ? <Notice tone="kelly">Style guide saved.</Notice> : null}
      {success === "guide_cleared" ? <Notice tone="ink">Style guide cleared — generation goes back to notes and examples only.</Notice> : null}
      {success === "extracted" ? <Notice tone="kelly">Style guide updated — based on {count ?? evidenceCount} revised recap{count === "1" ? "" : "s"}.</Notice> : null}

      <section className="flex flex-col gap-4">
        <SectionLabel>Tell the Writer How to Sound</SectionLabel>
        <p className="text-sm text-muted">Plain-language notes, always used — highest priority over everything below. Leave it blank if the style guide and examples are doing the job on their own.</p>
        <form action={saveVoiceNotesAction} className="flex flex-col gap-3">
          <textarea
            name="notes"
            defaultValue={manualNotes}
            rows={5}
            placeholder="e.g. Keep it punchy, cut the throat-clearing intro line, more jokes about bad bench decisions."
            className="w-full border border-line-sheet bg-sheet p-4 text-sm text-ink"
          />
          <div>
            <Button>Save Notes</Button>
          </div>
        </form>
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-sheet-strong pb-2.5">
          <h2 className="display text-[12px] tracking-[0.24em] text-muted">Learned Style Guide</h2>
          {/* Deferred-minors fix (Task 33 audit catch): saveManualStyleGuideText inherits the PRIOR
              active row's exemplarCount even when "Clear" empties guideText (so "based on N revised
              recaps" keeps meaning something if the commissioner later hand-edits the text back in)
              — but that inheritance made this pill read "Based on 3 revised recaps" right after a
              Clear, when there's no active guide text at all. Gate on guideText itself, not just
              evidenceCount, so a cleared guide reads honestly as "No active guide" instead of
              implying 3 recaps are still powering something that no longer exists. */}
          <span className="display rounded-full border border-line-sheet-strong px-3 py-1 text-[10px] tracking-[0.1em] text-muted">
            {guideText.trim().length === 0
              ? "No active guide"
              : evidenceCount > 0
                ? `Based on ${evidenceCount} revised recap${evidenceCount === 1 ? "" : "s"}`
                : "Based on 0 revised recaps — none yet"}
          </span>
        </div>

        {exemplarCount === 0 ? (
          <p className="text-sm text-muted">
            Nothing to learn from yet — this fills in on its own once you edit a draft before publishing it. Publish a recap as-is and there&apos;s nothing to learn; change something first.
          </p>
        ) : exemplarCount > evidenceCount ? (
          <p className="text-sm text-muted">
            {exemplarCount} revised recap{exemplarCount === 1 ? "" : "s"} captured now — {evidenceCount > 0 ? "more than the guide below was built from. " : ""}Update below to fold the newest ones in.
          </p>
        ) : null}

        <form action={updateWritingStyleAction}>
          <Button disabled={exemplarCount === 0}>Update writing style from my edits</Button>
        </form>

        <form action={saveStyleGuideTextAction} className="flex flex-col gap-3">
          <textarea
            name="guideText"
            defaultValue={guideText}
            rows={8}
            placeholder="No style guide yet — run “Update writing style from my edits” above once you've published a revised recap, or type one here yourself."
            className="w-full border border-line-sheet bg-sheet p-4 text-sm text-ink"
          />
          <div className="flex flex-wrap gap-3">
            {/* Two submit buttons, one form — the standard way to disambiguate intent server-side
                (formData.get("intent")) without a second <form> or any client JS. "Clear" ignores
                whatever's currently in the textarea and forces empty, in case the commissioner
                clicks it without having emptied the box first. */}
            <Button name="intent" value="save">
              Save Guide Text
            </Button>
            <button
              type="submit"
              name="intent"
              value="clear"
              className="display border border-line-sheet-strong px-4 py-2 text-xs tracking-[0.12em] text-muted hover:border-ink hover:text-ink"
            >
              Clear
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
