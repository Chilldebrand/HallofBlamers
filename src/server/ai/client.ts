import Anthropic from "@anthropic-ai/sdk";

/**
 * Shared Claude SDK plumbing used by BOTH src/server/ai/recap.ts (recap generation) and
 * src/server/ai/voice.ts (Task 16's style-guide extraction) — split out from recap.ts so voice.ts
 * can depend on it without recap.ts having to depend back on voice.ts (recap.ts's generateRecap
 * needs voice.ts's getGenerationVoiceContext; a two-way dependency would be a circular import).
 * recap.ts re-exports everything here under its original names so existing imports/tests of
 * "../recap" (RecapApiKeyMissingError, RECAP_MODEL, RECAP_CLIENT_MAX_RETRIES, computeCostUsd, the
 * RecapAnthropicClient/RecapFinalMessage types, etc.) keep working unchanged.
 */

export class RecapApiKeyMissingError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not set — cannot call the Claude API. Use renderFallbackRecap() or switch to fallback mode instead.");
    this.name = "RecapApiKeyMissingError";
  }
}

export const RECAP_MODEL = "claude-opus-5";
export const RECAP_CLIENT_MAX_RETRIES = 4;

/** Claude Opus 5 pricing at time of writing (see the claude-api skill's cached model table):
 * $5.00 per million input tokens, $25.00 per million output tokens. Used for BOTH recap
 * generation and voice-guide extraction — both call sites use RECAP_MODEL. */
const INPUT_USD_PER_TOKEN = 5 / 1_000_000;
const OUTPUT_USD_PER_TOKEN = 25 / 1_000_000;

export function computeCostUsd(tokensIn: number, tokensOut: number): number {
  return tokensIn * INPUT_USD_PER_TOKEN + tokensOut * OUTPUT_USD_PER_TOKEN;
}

// ---------------------------------------------------------------------------
// Injectable Claude client — narrow interface so tests can supply a plain
// mock object instead of a full Anthropic instance. The real `Anthropic`
// class satisfies this structurally.
// ---------------------------------------------------------------------------

export interface RecapMessageContentBlock {
  type: string;
  text?: string;
}

export interface RecapMessageUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface RecapFinalMessage {
  content: RecapMessageContentBlock[];
  usage: RecapMessageUsage;
}

export interface RecapMessageStream {
  finalMessage(): Promise<RecapFinalMessage>;
}

export interface RecapAnthropicClient {
  messages: {
    stream(params: {
      model: string;
      max_tokens: number;
      system: string;
      messages: { role: "user"; content: string }[];
    }): RecapMessageStream;
  };
}

export function createDefaultClient(): RecapAnthropicClient {
  if (!process.env.ANTHROPIC_API_KEY) throw new RecapApiKeyMissingError();
  // maxRetries: 4 per the brief's explicit call-shape requirement.
  return new Anthropic({ maxRetries: RECAP_CLIENT_MAX_RETRIES });
}

export function extractMarkdown(message: RecapFinalMessage): string {
  return message.content
    .filter((b): b is RecapMessageContentBlock & { text: string } => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}
