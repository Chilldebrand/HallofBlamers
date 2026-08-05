"use server";

import { redirect } from "next/navigation";
import { requireCommissioner } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import { RecapApiKeyMissingError } from "@/server/ai/recap";
import { extractStyleGuide, saveManualStyleGuideText, setManualVoiceNotes, VoiceExtractionNoExemplarsError } from "@/server/ai/voice";

/**
 * /admin/recaps/voice — same commissioner-only mutation-surface rule as every other admin action
 * in this feature (see src/features/recaps/actions.ts's docstring): every action here calls
 * requireCommissioner() itself, first thing.
 */

function redirectWithError(error: string): never {
  redirect(`/admin/recaps/voice?error=${encodeURIComponent(error)}`);
}

export async function saveVoiceNotesAction(formData: FormData): Promise<void> {
  await requireCommissioner();

  const notes = String(formData.get("notes") ?? "");
  const db = getDb();
  setManualVoiceNotes(db, notes);

  redirect("/admin/recaps/voice?success=notes_saved");
}

/**
 * Backs BOTH the "Save Guide Text" and "Clear" buttons in the same <form> (disambiguated by the
 * `intent` field each submit button carries — the standard multi-submit-button HTML pattern, no
 * second form or client JS needed). "Clear" forces empty text regardless of whatever's currently
 * typed in the textarea, so it works even if the commissioner clicks it without emptying the box
 * first.
 */
export async function saveStyleGuideTextAction(formData: FormData): Promise<void> {
  await requireCommissioner();

  const intent = String(formData.get("intent") ?? "save");
  const guideText = intent === "clear" ? "" : String(formData.get("guideText") ?? "");
  const db = getDb();
  saveManualStyleGuideText(db, guideText);

  redirect(`/admin/recaps/voice?success=${guideText.trim() ? "guide_saved" : "guide_cleared"}`);
}

/**
 * "Update writing style from my edits" — the commissioner-triggered extraction. Follows
 * generateRecapAction's exact try/catch shape (src/features/recaps/actions.ts): the SUCCESS
 * redirect happens OUTSIDE the try block (redirect() itself throws to interrupt rendering, and
 * must never be caught by our own catch), recognized errors get a clear plain-language banner via
 * redirectWithError, and anything unrecognized is re-thrown rather than swallowed. A failed
 * extraction never writes to recap_style_guides — see extractStyleGuide's docstring — so this
 * action changes nothing in the DB on any of these error paths, loudly (a visible Notice banner,
 * same as the rest of this admin surface).
 */
export async function updateWritingStyleAction(): Promise<void> {
  await requireCommissioner();

  const db = getDb();
  let exemplarCount: number;
  try {
    const guide = await extractStyleGuide({ db });
    exemplarCount = guide.exemplarCount;
  } catch (err) {
    if (err instanceof VoiceExtractionNoExemplarsError) {
      redirectWithError("No revised recaps yet — publish an edited recap first, then come back and update the style from it.");
    }
    if (err instanceof RecapApiKeyMissingError) {
      redirectWithError("No Claude API key is configured — set ANTHROPIC_API_KEY to learn a writing style automatically, or just type notes below instead.");
    }
    throw err;
  }

  redirect(`/admin/recaps/voice?success=extracted&count=${exemplarCount}`);
}
