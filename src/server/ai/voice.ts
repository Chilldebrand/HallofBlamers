import { desc, eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { appSettings, recapExemplars, recapStyleGuides, type Recap, type RecapExemplar, type RecapStyleGuide } from "@/server/db/schema";
import { computeCostUsd, createDefaultClient, extractMarkdown, RECAP_MODEL, type RecapAnthropicClient } from "./client";

/**
 * Task 16 — recap voice-learning: revision exemplars (captured on publish, see
 * `captureExemplarOnPublish`), the learned style guide extracted from them (versioned, see
 * `saveManualStyleGuideText`/`extractStyleGuide`), manual voice notes (a single app_settings
 * value), and assembling all three into the generation prompt's voice block (`buildVoiceBlock`,
 * consumed by recap.ts's `buildSystemPrompt`). recap.ts imports FROM this file (for
 * `getGenerationVoiceContext`/`buildVoiceBlock`); this file never imports FROM recap.ts — both
 * depend on the shared Claude-client plumbing in ./client instead, which is the whole reason that
 * file exists (see its docstring). NEVER calls the real Anthropic API without an injected
 * `client` — same binding rule as recap.ts.
 */

// ---------------------------------------------------------------------------
// Token budgeting — a cheap, deterministic estimate (no tokenizer dependency). Only ever used to
// decide what to TRIM before sending a request; the real API enforces its own exact limits
// regardless, so an approximation is fine here.
// ---------------------------------------------------------------------------

/** ~4 characters/token is the standard rough estimate for English prose/markdown. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Selects items from `itemsNewestFirst` (must already be sorted newest-first) up to `maxCount`,
 * stopping once the running token total would exceed `budget` — i.e. truncates OLDEST first,
 * since older items are the ones later in this newest-first list and are the ones left out. The
 * single newest item is always included even if it alone exceeds `budget` (never silently produce
 * zero examples just because the most recent one is large; every recap's markdown is bounded by
 * RECAP_MAX_TOKENS's output cap in practice, so this is a defensive floor, not the common case).
 */
export function selectWithinTokenBudget<T>(itemsNewestFirst: T[], maxCount: number, budget: number, textOf: (item: T) => string): T[] {
  const selected: T[] = [];
  let used = 0;
  for (const item of itemsNewestFirst) {
    if (selected.length >= maxCount) break;
    const cost = estimateTokens(textOf(item));
    if (selected.length > 0 && used + cost > budget) break;
    selected.push(item);
    used += cost;
  }
  return selected;
}

// ---------------------------------------------------------------------------
// Manual voice notes — a single free-text app_settings value, always included in generation
// (highest authority in buildVoiceBlock's ordering).
// ---------------------------------------------------------------------------

const MANUAL_VOICE_NOTES_KEY = "recap_voice_notes";

function readAppSetting(db: Db, key: string): unknown {
  return db.select({ valueJson: appSettings.valueJson }).from(appSettings).where(eq(appSettings.key, key)).get()?.valueJson;
}

function writeAppSetting(db: Db, key: string, value: unknown): void {
  const now = new Date();
  db.insert(appSettings)
    .values({ key, valueJson: value, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { valueJson: value, updatedAt: now } })
    .run();
}

export function getManualVoiceNotes(db: Db): string {
  const value = readAppSetting(db, MANUAL_VOICE_NOTES_KEY);
  return typeof value === "string" ? value : "";
}

export function setManualVoiceNotes(db: Db, notes: string): void {
  writeAppSetting(db, MANUAL_VOICE_NOTES_KEY, notes);
}

// ---------------------------------------------------------------------------
// Revision capture (exemplars) — deliverable 1. Idempotent by recapId: republishing the SAME
// recap upserts its one exemplar row in place, never duplicates. A publish where the published
// text equals what was originally generated captures nothing new AND removes any exemplar row
// already captured for that recap — the recap is unrevised as of this publish (whether it never
// was, or was revised and then reverted), so the capture table must not keep claiming otherwise.
// ---------------------------------------------------------------------------

export function getExemplarCount(db: Db): number {
  return db.select({ id: recapExemplars.id }).from(recapExemplars).all().length;
}

/** Most recent exemplars, newest first. */
export function getRecentExemplars(db: Db, limit: number): RecapExemplar[] {
  return db.select().from(recapExemplars).orderBy(desc(recapExemplars.capturedAt), desc(recapExemplars.id)).limit(limit).all();
}

/**
 * Called from publishRecapAction right after `recaps.markdownFinal`/`status` are updated.
 * `recap` is the row as read BEFORE that update (its `markdownGenerated` is what matters here —
 * frozen at creation, see schema.ts); `publishedMd` is the text that was just frozen into
 * `markdownFinal` (== `recap.markdownDraft` at call time, but passed explicitly so this function
 * never has to assume the caller's exact field-copy semantics).
 *
 * Three cases, per the brief:
 *  - `recap.markdownGenerated` is null (row predates this column, or was never backfilled) —
 *    there's no captured original to diff against. Captures nothing rather than fabricating one.
 *  - `recap.markdownGenerated === publishedMd` — unchanged publish: the recap is now unrevised,
 *    whether it never was, or was revised and then reverted back to the original text before this
 *    publish. DELETES any existing exemplar row for this recapId rather than merely skipping the
 *    insert (fix round 1, reviewer-flagged Important: edit A->B->publish captures an exemplar
 *    claiming "revised to B"; if the commissioner then edits back to A and republishes, that old
 *    row previously survived as a phantom — claiming a revision that, per the live recap, never
 *    happened. The capture table must reflect live truth, not a stale snapshot of a mid-revision
 *    state that was itself later undone).
 *  - otherwise — a real revision. Upserts by `recapId` (unique), so a later republish of the same
 *    recap (e.g. edit again, publish again) UPDATES this exemplar rather than adding a second one.
 */
export function captureExemplarOnPublish(db: Db, recap: Recap, publishedMd: string): void {
  const original = recap.markdownGenerated;
  if (!original) return;
  if (original === publishedMd) {
    db.delete(recapExemplars).where(eq(recapExemplars.recapId, recap.id)).run();
    return;
  }

  const now = new Date();
  db.insert(recapExemplars)
    .values({
      recapId: recap.id,
      season: recap.season,
      week: recap.week,
      style: recap.style,
      draftMd: original,
      publishedMd,
      capturedAt: now,
    })
    .onConflictDoUpdate({
      target: recapExemplars.recapId,
      set: { season: recap.season, week: recap.week, style: recap.style, draftMd: original, publishedMd, capturedAt: now },
    })
    .run();
}

// ---------------------------------------------------------------------------
// Learned style guide — deliverable 2. Versioned: every save (extraction OR manual tweak/clear)
// inserts a new row and deactivates the previous one, in a transaction. Exactly one active row at
// a time; whatever its `guideText` is is what generation uses (an empty string behaves as "no
// guide", same as never having extracted one).
// ---------------------------------------------------------------------------

export function getActiveStyleGuide(db: Db): RecapStyleGuide | null {
  return db.select().from(recapStyleGuides).where(eq(recapStyleGuides.isActive, true)).get() ?? null;
}

interface StyleGuideVersionInput {
  guideText: string;
  exemplarCount: number;
  sourceRecapIds: number[];
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
}

function saveStyleGuideVersion(db: Db, input: StyleGuideVersionInput): RecapStyleGuide {
  return db.transaction((tx) => {
    tx.update(recapStyleGuides).set({ isActive: false }).where(eq(recapStyleGuides.isActive, true)).run();
    return tx
      .insert(recapStyleGuides)
      .values({ ...input, isActive: true })
      .returning()
      .get();
  });
}

/**
 * The commissioner's "tweak or clear" path (deliverable 2's editable-text UI) — `guideText` can be
 * empty (clearing it, which then behaves exactly like no guide exists). Inherits the prior active
 * version's `exemplarCount`/`sourceRecapIds` unchanged so "based on N revised recaps" keeps
 * reflecting the real evidence base even after a human hand-edits the extracted text; `model` is
 * null (this version wasn't produced by an API call — same nullable convention as `recaps.model`).
 */
export function saveManualStyleGuideText(db: Db, guideText: string): RecapStyleGuide {
  const prior = getActiveStyleGuide(db);
  const priorSourceIds = (prior?.sourceRecapIds as number[] | null) ?? [];
  return saveStyleGuideVersion(db, {
    guideText,
    exemplarCount: prior?.exemplarCount ?? 0,
    sourceRecapIds: priorSourceIds,
    model: null,
    tokensIn: null,
    tokensOut: null,
    costUsd: null,
  });
}

// ---------------------------------------------------------------------------
// Extraction — the commissioner-triggered "Update writing style from my edits" action.
// ---------------------------------------------------------------------------

export class VoiceExtractionNoExemplarsError extends Error {
  constructor() {
    super("No revised recaps yet — there's nothing to learn from. Publish an edited recap first.");
    this.name = "VoiceExtractionNoExemplarsError";
  }
}

/** Same model as recap generation (RECAP_MODEL, "claude-opus-5") — one Claude model configured
 * for this whole feature, not a second one to keep track of. */
export const VOICE_EXTRACTION_MODEL = RECAP_MODEL;
export const VOICE_EXTRACTION_MAX_TOKENS = 1200;
/** How many of the most recent exemplars are even considered as extraction candidates, before
 * token-budget trimming — a generous ceiling; the token budget below is what actually limits the
 * prompt in practice for a league this size. */
export const VOICE_EXTRACTION_CANDIDATE_LIMIT = 20;
export const VOICE_EXTRACTION_TOKEN_BUDGET = 12000;

export const VOICE_EXTRACTION_GUARDRAIL = `You are analyzing a fantasy football commissioner's edits to AI-written weekly recaps. Below are pairs of (AI DRAFT, COMMISSIONER'S PUBLISHED VERSION) for several past recaps — different weeks, different results.

Extract ONLY durable VOICE and TONE guidance from what changed: word choice, sentence rhythm, humor level, formatting habits, what kind of lines the commissioner tends to cut or rewrite.

Do NOT extract or restate any facts, scores, player names, team names, dates, or other league-specific content from these examples — none of that is durable, and repeating it back would be a fabrication risk in a future recap about a completely different week. Write general, reusable style guidance only, as if writing a short style guide a different writer could follow for a future week with entirely different results.

Output plain text — a few short bullet points or a short paragraph. No preamble, no meta-commentary about this task, no restated instructions.`;

function formatExemplarPairForExtraction(ex: RecapExemplar): string {
  return `Season ${ex.season}, Week ${ex.week} (style: ${ex.style}):\n\nAI DRAFT:\n${ex.draftMd}\n\nCOMMISSIONER'S PUBLISHED VERSION:\n${ex.publishedMd}`;
}

/** Newest-first candidates -> token-budgeted selection -> the assembled prompt block. Exported
 * separately from `extractStyleGuide` so the truncation order is directly unit-testable without
 * mocking a Claude client. */
export function buildExtractionExemplarBlock(candidatesNewestFirst: RecapExemplar[]): { block: string; used: RecapExemplar[] } {
  const used = selectWithinTokenBudget(candidatesNewestFirst, VOICE_EXTRACTION_CANDIDATE_LIMIT, VOICE_EXTRACTION_TOKEN_BUDGET, formatExemplarPairForExtraction);
  const block = used.map(formatExemplarPairForExtraction).join("\n\n---\n\n");
  return { block, used };
}

export interface ExtractStyleGuideParams {
  db: Db;
  /** Injectable for tests — never omit in a test, so the real API is never called. */
  client?: RecapAnthropicClient;
}

/**
 * Assembles recent exemplar pairs (token-budgeted) into an extraction prompt, calls Claude, and —
 * ONLY on success — stores the result as the new active style guide version. Throws
 * `VoiceExtractionNoExemplarsError` when there's nothing to learn from yet, and
 * `RecapApiKeyMissingError` (from ./client, re-thrown unchanged) when no client was injected and
 * no ANTHROPIC_API_KEY is set. Neither error, nor any error the Claude call itself throws, ever
 * writes to `recap_style_guides` — a failed extraction changes nothing (the deterministic-fallback
 * philosophy the rest of the recap pipeline already follows).
 */
export async function extractStyleGuide(params: ExtractStyleGuideParams): Promise<RecapStyleGuide> {
  const { db } = params;
  const candidates = getRecentExemplars(db, VOICE_EXTRACTION_CANDIDATE_LIMIT);
  if (candidates.length === 0) throw new VoiceExtractionNoExemplarsError();

  const { block, used } = buildExtractionExemplarBlock(candidates);
  const client = params.client ?? createDefaultClient();

  const stream = client.messages.stream({
    model: VOICE_EXTRACTION_MODEL,
    max_tokens: VOICE_EXTRACTION_MAX_TOKENS,
    system: VOICE_EXTRACTION_GUARDRAIL,
    messages: [{ role: "user", content: `Here are ${used.length} revision pair(s) to learn from:\n\n${block}` }],
  });
  const message = await stream.finalMessage();

  const guideText = extractMarkdown(message);
  const tokensIn = message.usage.input_tokens;
  const tokensOut = message.usage.output_tokens;
  const costUsd = computeCostUsd(tokensIn, tokensOut);

  return saveStyleGuideVersion(db, {
    guideText,
    exemplarCount: used.length,
    sourceRecapIds: used.map((e) => e.recapId),
    model: VOICE_EXTRACTION_MODEL,
    tokensIn,
    tokensOut,
    costUsd,
  });
}

// ---------------------------------------------------------------------------
// Generation integration — deliverable 4/5. Authority ordering: manual notes > learned guide >
// few-shot exemplars. Cold start (nothing stored anywhere) must produce a prompt byte-identical to
// pre-Task-16 behavior — see buildVoiceBlock's and recap.ts's buildSystemPrompt's docstrings.
// ---------------------------------------------------------------------------

export interface RecapVoiceContext {
  manualNotes: string;
  learnedGuide: string;
  /** Already selected + token-budgeted — at most VOICE_FEWSHOT_MAX_COUNT, newest first. */
  exemplars: RecapExemplar[];
}

/** Brief's explicit cap: "up to 2 recent published recaps". */
export const VOICE_FEWSHOT_MAX_COUNT = 2;
export const VOICE_FEWSHOT_TOKEN_BUDGET = 3000;
/** How many recent exemplars are fetched as few-shot candidates before the count/budget caps
 * above are applied — only needs to be a little larger than VOICE_FEWSHOT_MAX_COUNT since the
 * current (season, week) being generated is filtered out of this pool afterward. */
const VOICE_FEWSHOT_CANDIDATE_LIMIT = 6;

function fewShotSampleText(ex: RecapExemplar): string {
  return ex.publishedMd;
}

/** Newest-first candidates -> up to VOICE_FEWSHOT_MAX_COUNT, token-budgeted, oldest dropped first
 * — exported for direct truncation-order testing, same reasoning as buildExtractionExemplarBlock. */
export function selectFewShotExemplars(candidatesNewestFirst: RecapExemplar[]): RecapExemplar[] {
  return selectWithinTokenBudget(candidatesNewestFirst, VOICE_FEWSHOT_MAX_COUNT, VOICE_FEWSHOT_TOKEN_BUDGET, fewShotSampleText);
}

/**
 * Reads everything generation needs from the DB: manual notes (app_settings), the active learned
 * guide (or "" if none), and up to VOICE_FEWSHOT_MAX_COUNT recent exemplars as few-shot voice
 * samples — excluding `currentSeason`/`currentWeek` itself, so regenerating an already-published
 * week's recap never quotes that same week back at itself as a "different week" example. With
 * nothing stored anywhere (true cold start, or simply before any exemplar has ever been
 * captured), returns all-empty fields, which `buildVoiceBlock` turns into the empty string.
 */
export function getGenerationVoiceContext(db: Db, currentSeason: number, currentWeek: number): RecapVoiceContext {
  const manualNotes = getManualVoiceNotes(db);
  const learnedGuide = getActiveStyleGuide(db)?.guideText ?? "";
  const candidates = getRecentExemplars(db, VOICE_FEWSHOT_CANDIDATE_LIMIT).filter((e) => !(e.season === currentSeason && e.week === currentWeek));
  const exemplars = selectFewShotExemplars(candidates);
  return { manualNotes, learnedGuide, exemplars };
}

/**
 * Formats a non-empty `RecapVoiceContext` into the block appended to the system prompt, in
 * authority order (manual notes > learned guide > few-shot exemplars) with a hard guardrail
 * repeated at the end. Returns the EXACT empty string "" when all three fields are empty — this is
 * the cold-start guarantee: `recap.ts`'s `buildSystemPrompt` only appends this block when it's
 * non-empty, so an empty context (nothing stored, or everything cleared back to empty) produces a
 * system prompt byte-identical to never having called this function at all.
 */
export function buildVoiceBlock(ctx: RecapVoiceContext): string {
  const parts: string[] = [];

  const notes = ctx.manualNotes.trim();
  if (notes) parts.push(`COMMISSIONER'S VOICE NOTES (highest priority — always follow these):\n${notes}`);

  const guide = ctx.learnedGuide.trim();
  if (guide) parts.push(`LEARNED STYLE GUIDE (extracted from past revisions):\n${guide}`);

  if (ctx.exemplars.length > 0) {
    const samples = ctx.exemplars
      .map((e, i) => `Sample ${i + 1} — season ${e.season}, week ${e.week}, a DIFFERENT week's published recap:\n${e.publishedMd}`)
      .join("\n\n");
    parts.push(`RECENT PUBLISHED RECAPS (voice reference only):\n${samples}`);
  }

  if (parts.length === 0) return "";

  const guardrail =
    "HARD GUARDRAIL: everything above this line describes VOICE AND TONE ONLY. It is never a source of facts. Every number, name, and event in the recap you write must still come exclusively from the FACTS JSON that follows. Never copy a name, score, date, or outcome from the guidance or examples above — they are from different weeks and are for tone reference only.";

  return `\n\n---\nVOICE GUIDANCE\n\n${parts.join("\n\n")}\n\n${guardrail}`;
}
