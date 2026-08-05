/**
 * Task 16 — recap voice-learning. Same binding rule as recap.test.ts: the real Anthropic API is
 * NEVER called here — extractStyleGuide always takes an injected mock client in these tests.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { recapExemplars, recaps, recapStyleGuides, type NewRecap, type Recap, type RecapExemplar } from "@/server/db/schema";
import { RecapApiKeyMissingError, type RecapAnthropicClient, type RecapFinalMessage } from "../client";
import { buildSystemPrompt } from "../recap";
import { RECAP_STYLES } from "../styles";
import {
  buildExtractionExemplarBlock,
  buildVoiceBlock,
  captureExemplarOnPublish,
  estimateTokens,
  extractStyleGuide,
  getActiveStyleGuide,
  getExemplarCount,
  getGenerationVoiceContext,
  getManualVoiceNotes,
  getRecentExemplars,
  saveManualStyleGuideText,
  selectFewShotExemplars,
  selectWithinTokenBudget,
  setManualVoiceNotes,
  VOICE_EXTRACTION_MODEL,
  VoiceExtractionNoExemplarsError,
  type RecapVoiceContext,
} from "../voice";

let db: Db;
let sqlite: Database.Database;
let dbPath: string;
let nextRecapId = 1;

beforeAll(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-voice-test-")), "test.db");
  const opened = createDb(dbPath);
  db = opened.db;
  sqlite = opened.sqlite;
  runMigrations(db);
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

function insertRecap(overrides: Partial<NewRecap> = {}): Recap {
  const season = overrides.season ?? 2025;
  const week = overrides.week ?? nextRecapId++;
  return db
    .insert(recaps)
    .values({
      season,
      week,
      style: "dry-coach",
      status: "draft",
      factsJson: { meta: { season, week } },
      markdownDraft: "as generated",
      markdownGenerated: "as generated",
      ...overrides,
    })
    .returning()
    .get();
}

function mockClient(finalMessage: RecapFinalMessage): { client: RecapAnthropicClient; calls: unknown[] } {
  const calls: unknown[] = [];
  const client: RecapAnthropicClient = {
    messages: {
      stream(params) {
        calls.push(params);
        return { finalMessage: async () => finalMessage };
      },
    },
  };
  return { client, calls };
}

// ---------------------------------------------------------------------------
// estimateTokens / selectWithinTokenBudget
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("is a ~4 chars/token estimate", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("selectWithinTokenBudget — truncation order", () => {
  it("keeps items newest-first and drops the OLDEST ones once the budget would be exceeded", () => {
    // Each "x".repeat(40) costs 10 tokens. Budget 15 -> the newest (10) fits, a second (10 more =
    // 20) does not -> only the newest survives.
    const items = ["newest", "middle", "oldest"];
    const selected = selectWithinTokenBudget(items, 10, 15, () => "x".repeat(40));
    expect(selected).toEqual(["newest"]);
  });

  it("keeps as many as fit, in newest-first order, before the budget cuts off", () => {
    const items = ["a", "b", "c"];
    const costs: Record<string, number> = { a: 10, b: 10, c: 100 };
    const selected = selectWithinTokenBudget(items, 10, 25, (i) => "x".repeat(costs[i]! * 4));
    expect(selected).toEqual(["a", "b"]); // a+b = 20 tokens fits in 25; adding c (100 tok) would not
  });

  it("respects maxCount even when the budget would allow more", () => {
    const items = ["a", "b", "c"];
    const selected = selectWithinTokenBudget(items, 2, 100000, () => "x");
    expect(selected).toEqual(["a", "b"]);
  });

  it("always includes the single newest item even if it alone exceeds the budget", () => {
    const items = ["huge", "small"];
    const selected = selectWithinTokenBudget(items, 10, 5, (i) => (i === "huge" ? "x".repeat(1000) : "x"));
    expect(selected).toEqual(["huge"]);
  });

  it("returns [] for an empty input list", () => {
    expect(selectWithinTokenBudget([], 5, 1000, () => "x")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Manual voice notes
// ---------------------------------------------------------------------------

describe("manual voice notes", () => {
  it("defaults to empty string when nothing is stored", () => {
    expect(getManualVoiceNotes(db)).toBe("");
  });

  it("round-trips through app_settings and can be overwritten", () => {
    setManualVoiceNotes(db, "Keep it punchy.");
    expect(getManualVoiceNotes(db)).toBe("Keep it punchy.");

    setManualVoiceNotes(db, "Actually, more deadpan.");
    expect(getManualVoiceNotes(db)).toBe("Actually, more deadpan.");
  });

  it("can be cleared back to empty", () => {
    setManualVoiceNotes(db, "temporary");
    setManualVoiceNotes(db, "");
    expect(getManualVoiceNotes(db)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Revision capture (exemplars)
// ---------------------------------------------------------------------------

describe("captureExemplarOnPublish", () => {
  it("a diff between markdownGenerated and the published text creates an exemplar row", () => {
    const recap = insertRecap({ markdownGenerated: "AI wrote this.", style: "trash-talk" });
    const before = getExemplarCount(db);

    captureExemplarOnPublish(db, recap, "Commissioner rewrote this.");

    expect(getExemplarCount(db)).toBe(before + 1);
    const row = db.select().from(recapExemplars).where(eq(recapExemplars.recapId, recap.id)).get();
    expect(row?.draftMd).toBe("AI wrote this.");
    expect(row?.publishedMd).toBe("Commissioner rewrote this.");
    expect(row?.style).toBe("trash-talk");
    expect(row?.season).toBe(recap.season);
    expect(row?.week).toBe(recap.week);
  });

  it("no diff (publish exactly what was generated) creates nothing", () => {
    const recap = insertRecap({ markdownGenerated: "unchanged text." });
    const before = getExemplarCount(db);

    captureExemplarOnPublish(db, recap, "unchanged text.");

    expect(getExemplarCount(db)).toBe(before);
    expect(db.select().from(recapExemplars).where(eq(recapExemplars.recapId, recap.id)).get()).toBeUndefined();
  });

  it("a null markdownGenerated (legacy row) creates nothing — never fabricates a diff", () => {
    const recap = insertRecap({ markdownGenerated: null });
    const before = getExemplarCount(db);

    captureExemplarOnPublish(db, recap, "whatever got published.");

    expect(getExemplarCount(db)).toBe(before);
  });

  it("republishing the SAME recap updates its exemplar in place — never duplicates", () => {
    const recap = insertRecap({ markdownGenerated: "v1 AI draft." });
    captureExemplarOnPublish(db, recap, "v1 published.");
    const afterFirst = getExemplarCount(db);

    // Simulate the commissioner editing again and republishing the SAME recap row.
    captureExemplarOnPublish(db, recap, "v2 published, edited again.");
    const afterSecond = getExemplarCount(db);

    expect(afterSecond).toBe(afterFirst); // no new row
    const row = db.select().from(recapExemplars).where(eq(recapExemplars.recapId, recap.id)).get();
    expect(row?.publishedMd).toBe("v2 published, edited again.");
  });

  it("revert-then-republish removes the stale exemplar — the live recap is unrevised again (fix round 1)", () => {
    const recap = insertRecap({ markdownGenerated: "A: the original AI draft." });

    // Edit A -> B, publish: captures an exemplar claiming this recap was revised to "B".
    captureExemplarOnPublish(db, recap, "B: the commissioner's edit.");
    expect(db.select().from(recapExemplars).where(eq(recapExemplars.recapId, recap.id)).get()?.publishedMd).toBe("B: the commissioner's edit.");

    // Commissioner reverts the edit back to the ORIGINAL text ("A") and republishes. This publish
    // is unchanged relative to markdownGenerated, so it correctly captures nothing NEW — but the
    // stale "B" exemplar from the prior publish is now a phantom (the live recap is back to
    // unrevised "A") and must be removed, not left behind.
    captureExemplarOnPublish(db, recap, "A: the original AI draft.");

    expect(db.select().from(recapExemplars).where(eq(recapExemplars.recapId, recap.id)).get()).toBeUndefined();
  });
});

describe("getRecentExemplars", () => {
  it("orders newest-first and respects the limit", () => {
    const dbPath2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-voice-recent-")), "test.db");
    const opened = createDb(dbPath2);
    runMigrations(opened.db);
    try {
      const r1 = opened.db.insert(recaps).values({ season: 2025, week: 1, style: "dry-coach", status: "draft", factsJson: {}, markdownGenerated: "g1" }).returning().get();
      const r2 = opened.db.insert(recaps).values({ season: 2025, week: 2, style: "dry-coach", status: "draft", factsJson: {}, markdownGenerated: "g2" }).returning().get();
      const r3 = opened.db.insert(recaps).values({ season: 2025, week: 3, style: "dry-coach", status: "draft", factsJson: {}, markdownGenerated: "g3" }).returning().get();

      opened.db
        .insert(recapExemplars)
        .values([
          { recapId: r1.id, season: 2025, week: 1, style: "dry-coach", draftMd: "g1", publishedMd: "p1", capturedAt: new Date(1000) },
          { recapId: r2.id, season: 2025, week: 2, style: "dry-coach", draftMd: "g2", publishedMd: "p2", capturedAt: new Date(2000) },
          { recapId: r3.id, season: 2025, week: 3, style: "dry-coach", draftMd: "g3", publishedMd: "p3", capturedAt: new Date(3000) },
        ])
        .run();

      const recent = getRecentExemplars(opened.db, 2);
      expect(recent.map((e) => e.publishedMd)).toEqual(["p3", "p2"]);
    } finally {
      opened.sqlite.close();
      fs.rmSync(path.dirname(dbPath2), { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Learned style guide (versioned)
// ---------------------------------------------------------------------------

describe("style guide versioning", () => {
  it("getActiveStyleGuide returns null when nothing has ever been saved", () => {
    const dbPath2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-voice-guide-")), "test.db");
    const opened = createDb(dbPath2);
    runMigrations(opened.db);
    try {
      expect(getActiveStyleGuide(opened.db)).toBeNull();
    } finally {
      opened.sqlite.close();
      fs.rmSync(path.dirname(dbPath2), { recursive: true, force: true });
    }
  });

  it("saveManualStyleGuideText creates the first active version with model null, exemplarCount 0", () => {
    const guide = saveManualStyleGuideText(db, "Be punchier.");
    expect(guide.guideText).toBe("Be punchier.");
    expect(guide.model).toBeNull();
    expect(guide.exemplarCount).toBe(0);
    expect(guide.isActive).toBe(true);
    expect(getActiveStyleGuide(db)?.id).toBe(guide.id);
  });

  it("a second save deactivates the previous version and keeps it in history", () => {
    const first = saveManualStyleGuideText(db, "First version.");
    const second = saveManualStyleGuideText(db, "Second version.");

    expect(second.id).not.toBe(first.id);
    expect(getActiveStyleGuide(db)?.id).toBe(second.id);

    const firstReloaded = db.select().from(recapStyleGuides).where(eq(recapStyleGuides.id, first.id)).get();
    expect(firstReloaded?.isActive).toBe(false);
    expect(firstReloaded?.guideText).toBe("First version."); // history preserved, not mutated
  });

  it("clearing (empty text) is just another version with empty guideText", () => {
    saveManualStyleGuideText(db, "Something.");
    const cleared = saveManualStyleGuideText(db, "");
    expect(cleared.guideText).toBe("");
    expect(getActiveStyleGuide(db)?.guideText).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

describe("extractStyleGuide", () => {
  it("throws VoiceExtractionNoExemplarsError with zero exemplars, and touches nothing", async () => {
    const dbPath2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-voice-extract-empty-")), "test.db");
    const opened = createDb(dbPath2);
    runMigrations(opened.db);
    try {
      const before = opened.db.select().from(recapStyleGuides).all().length;
      await expect(extractStyleGuide({ db: opened.db })).rejects.toThrow(VoiceExtractionNoExemplarsError);
      expect(opened.db.select().from(recapStyleGuides).all().length).toBe(before);
    } finally {
      opened.sqlite.close();
      fs.rmSync(path.dirname(dbPath2), { recursive: true, force: true });
    }
  });

  it("throws RecapApiKeyMissingError when no client is injected and ANTHROPIC_API_KEY is unset, and changes nothing", async () => {
    const recap = insertRecap({ markdownGenerated: "draft" });
    captureExemplarOnPublish(db, recap, "published, revised");
    const before = db.select().from(recapStyleGuides).all().length;

    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(extractStyleGuide({ db })).rejects.toThrow(RecapApiKeyMissingError);
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    }
    expect(db.select().from(recapStyleGuides).all().length).toBe(before);
  });

  it("on a successful call, stores the extracted text as the new active version with usage/cost", async () => {
    const recap = insertRecap({ markdownGenerated: "AI original.", style: "epic-documentary" });
    captureExemplarOnPublish(db, recap, "Commissioner's rewrite.");

    const { client, calls } = mockClient({
      content: [{ type: "text", text: "- Shorter sentences.\n- More jokes about bench decisions." }],
      usage: { input_tokens: 500, output_tokens: 40 },
    });

    const guide = await extractStyleGuide({ db, client });

    expect(guide.guideText).toBe("- Shorter sentences.\n- More jokes about bench decisions.");
    expect(guide.model).toBe(VOICE_EXTRACTION_MODEL);
    expect(guide.tokensIn).toBe(500);
    expect(guide.tokensOut).toBe(40);
    expect(guide.costUsd).toBeGreaterThan(0);
    expect(guide.isActive).toBe(true);
    expect((guide.sourceRecapIds as number[]).includes(recap.id)).toBe(true);

    expect(calls).toHaveLength(1);
    const call = calls[0] as { model: string; system: string; messages: { content: string }[] };
    expect(call.model).toBe(VOICE_EXTRACTION_MODEL);
    expect(call.system).toContain("Do NOT extract or restate any facts");
    expect(call.messages[0]!.content).toContain("AI original.");
    expect(call.messages[0]!.content).toContain("Commissioner's rewrite.");
  });

  it("a failed Claude call never writes a row", async () => {
    const recap = insertRecap({ markdownGenerated: "yet another draft" });
    captureExemplarOnPublish(db, recap, "yet another published version");
    const before = db.select().from(recapStyleGuides).all().length;

    const client: RecapAnthropicClient = {
      messages: {
        stream() {
          throw new Error("simulated API failure");
        },
      },
    };

    await expect(extractStyleGuide({ db, client })).rejects.toThrow("simulated API failure");
    expect(db.select().from(recapStyleGuides).all().length).toBe(before);
  });
});

describe("buildExtractionExemplarBlock — truncation order", () => {
  it("drops the OLDEST exemplar pairs first once the token budget is exceeded", () => {
    const big = "x".repeat(60000); // ~15000 tokens each, well over VOICE_EXTRACTION_TOKEN_BUDGET
    const newest: RecapExemplar = { id: 3, recapId: 3, season: 2025, week: 3, style: "dry-coach", draftMd: big, publishedMd: "p3", capturedAt: new Date(3000) };
    const middle: RecapExemplar = { id: 2, recapId: 2, season: 2025, week: 2, style: "dry-coach", draftMd: big, publishedMd: "p2", capturedAt: new Date(2000) };
    const oldest: RecapExemplar = { id: 1, recapId: 1, season: 2025, week: 1, style: "dry-coach", draftMd: big, publishedMd: "p1", capturedAt: new Date(1000) };

    const { used } = buildExtractionExemplarBlock([newest, middle, oldest]);

    expect(used.map((e) => e.recapId)).toEqual([3]); // only the newest fits
  });
});

// ---------------------------------------------------------------------------
// Few-shot generation context
// ---------------------------------------------------------------------------

describe("selectFewShotExemplars — cap + truncation order", () => {
  it("never exceeds VOICE_FEWSHOT_MAX_COUNT (2) even with many small candidates", () => {
    const candidates: RecapExemplar[] = [1, 2, 3, 4].map((n) => ({
      id: n,
      recapId: n,
      season: 2025,
      week: n,
      style: "dry-coach",
      draftMd: "d",
      publishedMd: `p${n}`,
      capturedAt: new Date(n * 1000),
    }));
    const selected = selectFewShotExemplars([...candidates].reverse()); // caller passes newest-first
    expect(selected).toHaveLength(2);
  });

  it("drops the older sample first when the budget can only fit one", () => {
    const big = "x".repeat(20000);
    const newer: RecapExemplar = { id: 2, recapId: 2, season: 2025, week: 2, style: "dry-coach", draftMd: "d", publishedMd: big, capturedAt: new Date(2000) };
    const older: RecapExemplar = { id: 1, recapId: 1, season: 2025, week: 1, style: "dry-coach", draftMd: "d", publishedMd: big, capturedAt: new Date(1000) };
    const selected = selectFewShotExemplars([newer, older]);
    expect(selected.map((e) => e.recapId)).toEqual([2]);
  });
});

describe("getGenerationVoiceContext", () => {
  it("returns all-empty fields on a completely fresh DB (true cold start)", () => {
    const dbPath2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-voice-cold-")), "test.db");
    const opened = createDb(dbPath2);
    runMigrations(opened.db);
    try {
      const ctx = getGenerationVoiceContext(opened.db, 2025, 1);
      expect(ctx).toEqual({ manualNotes: "", learnedGuide: "", exemplars: [] });
    } finally {
      opened.sqlite.close();
      fs.rmSync(path.dirname(dbPath2), { recursive: true, force: true });
    }
  });

  it("excludes an exemplar matching the (season, week) currently being generated", () => {
    const dbPath2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-voice-selfexclude-")), "test.db");
    const opened = createDb(dbPath2);
    runMigrations(opened.db);
    try {
      const r1 = opened.db.insert(recaps).values({ season: 2025, week: 5, style: "dry-coach", status: "published", factsJson: {}, markdownGenerated: "g" }).returning().get();
      opened.db.insert(recapExemplars).values({ recapId: r1.id, season: 2025, week: 5, style: "dry-coach", draftMd: "g", publishedMd: "self-week published text", capturedAt: new Date() }).run();

      const ctxSameWeek = getGenerationVoiceContext(opened.db, 2025, 5);
      expect(ctxSameWeek.exemplars).toEqual([]);

      const ctxDifferentWeek = getGenerationVoiceContext(opened.db, 2025, 6);
      expect(ctxDifferentWeek.exemplars).toHaveLength(1);
    } finally {
      opened.sqlite.close();
      fs.rmSync(path.dirname(dbPath2), { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// buildVoiceBlock — authority ordering + cold-start byte-identical
// ---------------------------------------------------------------------------

describe("buildVoiceBlock", () => {
  const sampleExemplar: RecapExemplar = {
    id: 1,
    recapId: 1,
    season: 2025,
    week: 1,
    style: "dry-coach",
    draftMd: "draft",
    publishedMd: "Commissioner's published sample.",
    capturedAt: new Date(),
  };

  it("returns exactly '' for an all-empty context", () => {
    expect(buildVoiceBlock({ manualNotes: "", learnedGuide: "", exemplars: [] })).toBe("");
  });

  it("returns '' when fields are whitespace-only", () => {
    expect(buildVoiceBlock({ manualNotes: "   ", learnedGuide: "\n\t", exemplars: [] })).toBe("");
  });

  it("notes only", () => {
    const block = buildVoiceBlock({ manualNotes: "Be punchier.", learnedGuide: "", exemplars: [] });
    expect(block).toContain("COMMISSIONER'S VOICE NOTES");
    expect(block).toContain("Be punchier.");
    expect(block).not.toContain("LEARNED STYLE GUIDE");
    expect(block).not.toContain("RECENT PUBLISHED RECAPS");
  });

  it("guide only", () => {
    const block = buildVoiceBlock({ manualNotes: "", learnedGuide: "Shorter sentences.", exemplars: [] });
    expect(block).toContain("LEARNED STYLE GUIDE");
    expect(block).toContain("Shorter sentences.");
    expect(block).not.toContain("COMMISSIONER'S VOICE NOTES");
    expect(block).not.toContain("RECENT PUBLISHED RECAPS");
  });

  it("exemplars only", () => {
    const block = buildVoiceBlock({ manualNotes: "", learnedGuide: "", exemplars: [sampleExemplar] });
    expect(block).toContain("RECENT PUBLISHED RECAPS");
    expect(block).toContain("Commissioner's published sample.");
    expect(block).not.toContain("COMMISSIONER'S VOICE NOTES");
    expect(block).not.toContain("LEARNED STYLE GUIDE");
  });

  it("all three, in authority order: notes > guide > exemplars", () => {
    const block = buildVoiceBlock({ manualNotes: "NOTES-TEXT", learnedGuide: "GUIDE-TEXT", exemplars: [sampleExemplar] });
    const notesIdx = block.indexOf("NOTES-TEXT");
    const guideIdx = block.indexOf("GUIDE-TEXT");
    const exemplarIdx = block.indexOf("Commissioner's published sample.");
    expect(notesIdx).toBeGreaterThan(-1);
    expect(guideIdx).toBeGreaterThan(notesIdx);
    expect(exemplarIdx).toBeGreaterThan(guideIdx);
  });

  it("always includes the hard guardrail when any part is present", () => {
    const block = buildVoiceBlock({ manualNotes: "x", learnedGuide: "", exemplars: [] });
    expect(block).toContain("HARD GUARDRAIL");
    expect(block).toContain("come exclusively from the FACTS JSON");
  });
});

describe("buildSystemPrompt — cold start byte-identical (Task 16 deliverable 5)", () => {
  const style = RECAP_STYLES[0]!;

  it("omitting `voice` entirely is unchanged from pre-Task-16 buildSystemPrompt(style)", () => {
    expect(buildSystemPrompt(style)).toBe(buildSystemPrompt(style));
  });

  it("an explicit all-empty voice context produces a BYTE-IDENTICAL prompt to omitting it", () => {
    const empty: RecapVoiceContext = { manualNotes: "", learnedGuide: "", exemplars: [] };
    expect(buildSystemPrompt(style, empty)).toBe(buildSystemPrompt(style));
  });

  it("a non-empty voice context DOES change the prompt (sanity check the guarantee isn't vacuous)", () => {
    const withNotes: RecapVoiceContext = { manualNotes: "Be punchier.", learnedGuide: "", exemplars: [] };
    expect(buildSystemPrompt(style, withNotes)).not.toBe(buildSystemPrompt(style));
    expect(buildSystemPrompt(style, withNotes)).toContain("Be punchier.");
  });
});
