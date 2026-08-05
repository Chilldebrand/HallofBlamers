import type { Db } from "@/server/db/client";
import { recaps, type Recap } from "@/server/db/schema";
import {
  computeCostUsd,
  createDefaultClient,
  extractMarkdown,
  RECAP_CLIENT_MAX_RETRIES,
  RECAP_MODEL,
  RecapApiKeyMissingError,
  type RecapAnthropicClient,
  type RecapFinalMessage,
  type RecapMessageContentBlock,
  type RecapMessageStream,
  type RecapMessageUsage,
} from "./client";
import { buildWeekFacts, type WeekFacts } from "./facts";
import { getRecapStyle, type RecapStyle } from "./styles";
import { buildVoiceBlock, getGenerationVoiceContext, type RecapVoiceContext } from "./voice";

// Re-exported so every existing consumer/test of "./recap" keeps working unchanged — these now
// live in ./client (shared with voice.ts's extraction call; see that file's docstring for why).
export { computeCostUsd, RECAP_CLIENT_MAX_RETRIES, RECAP_MODEL, RecapApiKeyMissingError };
export type { RecapAnthropicClient, RecapFinalMessage, RecapMessageContentBlock, RecapMessageStream, RecapMessageUsage };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RecapInvalidStyleError extends Error {
  constructor(styleId: string) {
    super(`"${styleId}" is not a recognized recap style id.`);
    this.name = "RecapInvalidStyleError";
  }
}

// ---------------------------------------------------------------------------
// Model config
// ---------------------------------------------------------------------------

export const RECAP_MAX_TOKENS = 4000;
export const RECAP_PROMPT_VERSION = "v1";

// ---------------------------------------------------------------------------
// Guardrail block + prompt assembly
// ---------------------------------------------------------------------------

/**
 * Fixed, verbatim guardrail requirements (brief's exact list) — never altered per-style, never
 * altered per-request. The style fragment is appended after this, not blended into it.
 */
export const RECAP_GUARDRAIL_BLOCK = `You are writing a fantasy football league's weekly recap. Follow these rules exactly:

- Every number, player name, and historical claim you write MUST come from the FACTS JSON provided below. Never invent a stat, a name, or an outcome that isn't in the facts.
- Historical or "this has never happened before" context may ONLY come from the "records" and "contextNotes" lines already provided in the facts — never from your own knowledge of the league or of fantasy football history in general.
- Never mention player injuries, or any real-world NFL news, roster moves, or events — this league only cares about what happened inside its own fantasy matchups.
- Write in Markdown: a title, one section per matchup, and a superlatives section.
- Do not include any preamble about being an AI, a disclaimer, or a note about how you approached the task. Start directly with the recap's title.`;

/**
 * `voice` is optional and, when omitted OR when it resolves to an empty block (Task 16's cold
 * start: no manual notes, no learned guide, no exemplars), the returned string is BYTE-IDENTICAL
 * to the pre-Task-16 `buildSystemPrompt(style)` — see voice.ts's `buildVoiceBlock` docstring for
 * the guarantee this relies on. Never called with a partially-empty voice context by accident:
 * `generateRecap` always builds it via `getGenerationVoiceContext`, which returns all-empty fields
 * when the DB has nothing stored yet, rather than omitting fields.
 */
export function buildSystemPrompt(style: RecapStyle, voice?: RecapVoiceContext): string {
  const base = `${RECAP_GUARDRAIL_BLOCK}\n\nVoice for this recap: ${style.systemFragment}`;
  const voiceBlock = voice ? buildVoiceBlock(voice) : "";
  return voiceBlock ? `${base}${voiceBlock}` : base;
}

export function buildUserPrompt(facts: WeekFacts): string {
  return `Here are the facts for season ${facts.meta.season}, week ${facts.meta.week}. Write the recap now, using ONLY what's in this JSON:\n\n${JSON.stringify(facts, null, 2)}`;
}

// ---------------------------------------------------------------------------
// generateRecap
// ---------------------------------------------------------------------------

export interface GenerateRecapParams {
  db: Db;
  season: number;
  week: number;
  styleId: string;
  /** Injectable for tests — never omit in a test, so the real API is never called. */
  client?: RecapAnthropicClient;
}

/**
 * Builds this week's facts, calls Claude (model + guardrail block + style fragment + facts JSON),
 * and stores a NEW `recaps` row (status 'draft'). Throws `RecapIncompleteWeekError` (via
 * `buildWeekFacts`) for an incomplete week, `RecapInvalidStyleError` for an unknown style id, and
 * `RecapApiKeyMissingError` when no client was injected AND no ANTHROPIC_API_KEY is set — the
 * caller (the admin UI) should catch that last one and steer toward `renderFallbackRecap` instead.
 */
export async function generateRecap(params: GenerateRecapParams): Promise<Recap> {
  const { db, season, week, styleId } = params;
  const style = getRecapStyle(styleId);
  if (!style) throw new RecapInvalidStyleError(styleId);

  const facts = buildWeekFacts(db, season, week);
  const client = params.client ?? createDefaultClient();
  // Task 16: manual notes / learned guide / few-shot exemplars, excluding this exact (season,
  // week) so a regenerate of an already-published week never quotes itself as a "different week"
  // voice sample. All-empty (cold start, or simply nothing captured yet) makes buildSystemPrompt
  // byte-identical to its pre-Task-16 output — see that function's docstring.
  const voice = getGenerationVoiceContext(db, season, week);

  const stream = client.messages.stream({
    model: RECAP_MODEL,
    max_tokens: RECAP_MAX_TOKENS,
    system: buildSystemPrompt(style, voice),
    messages: [{ role: "user", content: buildUserPrompt(facts) }],
  });
  const message = await stream.finalMessage();

  const markdown = extractMarkdown(message);
  const tokensIn = message.usage.input_tokens;
  const tokensOut = message.usage.output_tokens;
  const costUsd = computeCostUsd(tokensIn, tokensOut);

  return db
    .insert(recaps)
    .values({
      season,
      week,
      style: styleId,
      status: "draft",
      factsJson: facts,
      promptVersion: RECAP_PROMPT_VERSION,
      model: RECAP_MODEL,
      markdownDraft: markdown,
      // Frozen "as generated" copy for Task 16's revision-capture diff — see the column's
      // docstring in schema.ts. Set once, here, and never touched again.
      markdownGenerated: markdown,
      markdownFinal: null,
      tokensIn,
      tokensOut,
      costUsd,
    })
    .returning()
    .get();
}

// ---------------------------------------------------------------------------
// Fallback: deterministic, no API, always available
// ---------------------------------------------------------------------------

function formatRecordShort(t: { wins: number; losses: number; ties: number }): string {
  return `${t.wins}-${t.losses}${t.ties > 0 ? `-${t.ties}` : ""}`;
}

/** Deterministic markdown recap built entirely from `facts` — no network call, always available.
 * Used both as the "switch to fallback" admin action and as the default when no API key is set. */
export function renderFallbackRecap(facts: WeekFacts): string {
  const lines: string[] = [];

  lines.push(`# Week ${facts.meta.week} Recap`);
  lines.push("");
  lines.push("_A deterministic recap generated without calling the API — every line here is read directly from that week's facts._");
  lines.push("");

  lines.push("## Standings");
  for (const s of facts.standings) {
    const movement = s.rankMovement === null ? "" : s.rankMovement > 0 ? ` (up ${s.rankMovement})` : s.rankMovement < 0 ? ` (down ${Math.abs(s.rankMovement)})` : " (steady)";
    lines.push(`${s.rank}. ${s.franchiseName} — ${formatRecordShort(s)}, ${s.pointsFor.toFixed(1)} pts${movement}`);
  }
  lines.push("");

  lines.push("## Matchups");
  for (const m of facts.matchups) {
    const title = m.away ? `${m.home.franchiseName} vs. ${m.away.franchiseName}` : `${m.home.franchiseName} — Bye`;
    lines.push(`### ${title}`);
    if (m.away) {
      const marginText = m.margin !== null ? ` (margin ${m.margin.toFixed(1)})` : "";
      lines.push(`Final: ${m.home.franchiseName} ${m.home.score.toFixed(1)} — ${m.away.franchiseName} ${m.away.score.toFixed(1)}${marginText}.`);
    } else {
      lines.push(`${m.home.franchiseName} had the week off.`);
    }
    if (m.topPerformers.length > 0) {
      const names = m.topPerformers.map((p) => `${p.playerName} (${p.franchiseName}, ${p.points.toFixed(1)} pts)`).join(", ");
      lines.push(`Top performers: ${names}.`);
    }
    if (m.h2hAfter) lines.push(m.h2hAfter);
    if (m.belt) {
      lines.push(
        m.belt.result === "transfer"
          ? `${m.belt.challengerName} took the belt from ${m.belt.holderName}.`
          : `${m.belt.holderName} defended the belt against ${m.belt.challengerName}.`,
      );
    }
    for (const note of m.contextNotes) lines.push(`- ${note}`);
    lines.push("");
  }

  lines.push("## Superlatives");
  const sup = facts.superlatives;
  if (sup.topScore) lines.push(`- Top Score: ${sup.topScore.franchiseName}, ${sup.topScore.value.toFixed(1)} pts.`);
  if (sup.lowScore) lines.push(`- Low Score: ${sup.lowScore.franchiseName}, ${sup.lowScore.value.toFixed(1)} pts.`);
  if (sup.closest) lines.push(`- Closest Game: ${sup.closest.winnerName} over ${sup.closest.loserName} by ${sup.closest.margin.toFixed(1)}.`);
  if (sup.blowout) lines.push(`- Biggest Blowout: ${sup.blowout.winnerName} over ${sup.blowout.loserName} by ${sup.blowout.margin.toFixed(1)}.`);
  // Task 17 — named exactly "Beatdown of the Week" per the brief; `margin` is signed (negative),
  // shown as its absolute value here since "lost by -38.4" reads oddly in prose.
  if (sup.beatdown) lines.push(`- Beatdown of the Week: ${sup.beatdown.franchiseName} lost to ${sup.beatdown.opponentName} by ${Math.abs(sup.beatdown.margin).toFixed(1)}.`);
  if (sup.benchDisaster) lines.push(`- Bench Disaster: ${sup.benchDisaster.franchiseName} left ${sup.benchDisaster.value.toFixed(1)} points on the bench.`);
  if (sup.luckiestWin) lines.push(`- Luckiest Win: ${sup.luckiestWin.franchiseName} (luck score ${sup.luckiestWin.luckScore.toFixed(2)}).`);
  if (sup.bestEfficiency) lines.push(`- Best Efficiency: ${sup.bestEfficiency.franchiseName} (${sup.bestEfficiency.value.toFixed(3)} efficiency).`);
  lines.push("");

  if (facts.records.broken.length > 0 || facts.records.approached.length > 0) {
    lines.push("## Record Book");
    for (const r of facts.records.broken) lines.push(`- Broken: ${r.text}`);
    for (const r of facts.records.approached) lines.push(`- Approached: ${r.franchiseName}, #${r.rank} all-time (${r.value.toFixed(1)}).`);
    lines.push("");
  }

  if (facts.transactions.trades.length > 0 || facts.transactions.notableAdds.length > 0) {
    lines.push("## Transactions");
    for (const t of facts.transactions.trades) {
      const parts = t.franchises.map((f) => `${f.franchiseName} received ${f.received.length > 0 ? f.received.join(", ") : "nothing listed"}`);
      lines.push(`- Trade: ${parts.join("; ")}.`);
    }
    for (const a of facts.transactions.notableAdds) lines.push(`- ${a.franchiseName} added ${a.playerName} (${a.points.toFixed(1)} pts).`);
    lines.push("");
  }

  if (facts.playoffPicture && facts.playoffPicture.length > 0) {
    lines.push("## Playoff Picture");
    for (const s of facts.playoffPicture) lines.push(`- ${s}`);
    lines.push("");
  }

  if (facts.commissionerNotes) {
    lines.push("## Commissioner Notes");
    lines.push(facts.commissionerNotes);
    lines.push("");
  }

  return lines.join("\n").trim();
}
