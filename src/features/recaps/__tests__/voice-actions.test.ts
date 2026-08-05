/**
 * Task 16 — requireCommissioner() gating for every voice-learning admin action, plus mocked
 * success/failure paths for updateWritingStyleAction (the "Update writing style from my edits"
 * extraction action). Same pattern as src/features/recaps/__tests__/actions.test.ts: mocks
 * next/headers/next/navigation, points the db/client singleton at a seeded temp DB. The Anthropic
 * SDK itself is mocked at module level (never the real API — binding rule) so a genuine
 * success-path assertion can run through the Server Action's own createDefaultClient() call, not
 * just through voice.ts's directly-injected-client tests (see src/server/ai/__tests__/voice.test.ts
 * for those).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const currentCookie: { sessionToken: string | undefined } = { sessionToken: undefined };

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "wbb_session" && currentCookie.sessionToken ? { value: currentCookie.sessionToken } : undefined),
    set: vi.fn(),
  }),
}));

class RedirectSignal extends Error {
  constructor(public url: string) {
    super(`REDIRECT:${url}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (url: string): never => {
    throw new RedirectSignal(url);
  },
}));

let mockFinalMessage: { content: { type: string; text?: string }[]; usage: { input_tokens: number; output_tokens: number } } = {
  content: [{ type: "text", text: "- Mocked extracted style guidance." }],
  usage: { input_tokens: 10, output_tokens: 5 },
};

// Mocked at module level (never the real Anthropic API — binding rule for this task) so
// updateWritingStyleAction's own createDefaultClient() call is exercised end-to-end.
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      stream: () => ({
        finalMessage: async () => mockFinalMessage,
      }),
    };
  },
}));

const { createDb, getSqlite } = await import("../../../server/db/client");
const { runMigrations } = await import("../../../server/db/migrate");
const { managers, recapExemplars, recaps, recapStyleGuides } = await import("../../../server/db/schema");
const { createSessionToken } = await import("../../../server/auth/session");
const { saveStyleGuideTextAction, saveVoiceNotesAction, updateWritingStyleAction } = await import("../voice-actions");

type Db = Awaited<ReturnType<typeof createDb>>["db"];

let db: Db;
let sqlite: Database.Database;
let dbPath: string;
const SEASON = 2025;
let managerCounter = 0;

beforeAll(() => {
  process.env.SESSION_SECRET = "b".repeat(32);
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-voice-actions-test-")), "test.db");
  process.env.DATABASE_PATH = dbPath;
  const opened = createDb(dbPath);
  db = opened.db;
  sqlite = opened.sqlite;
  runMigrations(db);
});

afterAll(() => {
  sqlite.close();
  getSqlite().close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

afterEach(() => {
  currentCookie.sessionToken = undefined;
});

async function asManager(role: "commissioner" | "manager"): Promise<void> {
  managerCounter += 1;
  const manager = db.insert(managers).values({ name: `${role}-${managerCounter}`, role, inviteToken: `tok-voice-action-${managerCounter}` }).returning().get();
  currentCookie.sessionToken = await createSessionToken(manager.id);
}

async function callAndCaptureRedirect(fn: () => Promise<void>): Promise<RedirectSignal> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof RedirectSignal) return e;
    throw e;
  }
  throw new Error("expected a redirect, but the action returned normally");
}

// ---------------------------------------------------------------------------
// requireCommissioner gating — all three actions
// ---------------------------------------------------------------------------

describe("saveVoiceNotesAction — requireCommissioner gating", () => {
  it("rejects a manager-role session and never writes app_settings", async () => {
    await asManager("manager");
    const formData = new FormData();
    formData.set("notes", "should never be saved");

    const signal = await callAndCaptureRedirect(() => saveVoiceNotesAction(formData));
    expect(signal.url).toBe("/");
  });

  it("rejects an unauthenticated request", async () => {
    currentCookie.sessionToken = undefined;
    const formData = new FormData();
    formData.set("notes", "x");

    const signal = await callAndCaptureRedirect(() => saveVoiceNotesAction(formData));
    expect(signal.url).toBe("/login");
  });

  it("accepts a commissioner-role session and saves the notes", async () => {
    await asManager("commissioner");
    const formData = new FormData();
    formData.set("notes", "Be punchier, please.");

    const signal = await callAndCaptureRedirect(() => saveVoiceNotesAction(formData));
    expect(signal.url).toBe("/admin/recaps/voice?success=notes_saved");
  });
});

describe("saveStyleGuideTextAction — requireCommissioner gating", () => {
  it("rejects a manager-role session and never writes recap_style_guides", async () => {
    await asManager("manager");
    const before = db.select().from(recapStyleGuides).all().length;
    const formData = new FormData();
    formData.set("guideText", "should never be saved");

    const signal = await callAndCaptureRedirect(() => saveStyleGuideTextAction(formData));
    expect(signal.url).toBe("/");
    expect(db.select().from(recapStyleGuides).all().length).toBe(before);
  });

  it("accepts a commissioner-role session, saving non-empty text as 'guide_saved'", async () => {
    await asManager("commissioner");
    const formData = new FormData();
    formData.set("guideText", "Shorter sentences.");

    const signal = await callAndCaptureRedirect(() => saveStyleGuideTextAction(formData));
    expect(signal.url).toBe("/admin/recaps/voice?success=guide_saved");
  });

  it("saving empty text redirects as 'guide_cleared'", async () => {
    await asManager("commissioner");
    const formData = new FormData();
    formData.set("guideText", "");

    const signal = await callAndCaptureRedirect(() => saveStyleGuideTextAction(formData));
    expect(signal.url).toBe("/admin/recaps/voice?success=guide_cleared");
  });

  it("intent=clear forces empty text even if the textarea field carries stale non-empty content", async () => {
    await asManager("commissioner");
    const formData = new FormData();
    formData.set("guideText", "leftover text the Clear button should ignore");
    formData.set("intent", "clear");

    const signal = await callAndCaptureRedirect(() => saveStyleGuideTextAction(formData));
    expect(signal.url).toBe("/admin/recaps/voice?success=guide_cleared");

    const active = db.select().from(recapStyleGuides).where(eq(recapStyleGuides.isActive, true)).get();
    expect(active?.guideText).toBe("");
  });
});

describe("updateWritingStyleAction — requireCommissioner gating", () => {
  it("rejects a manager-role session and never touches recap_style_guides", async () => {
    await asManager("manager");
    const before = db.select().from(recapStyleGuides).all().length;

    const signal = await callAndCaptureRedirect(() => updateWritingStyleAction());
    expect(signal.url).toBe("/");
    expect(db.select().from(recapStyleGuides).all().length).toBe(before);
  });

  it("rejects an unauthenticated request", async () => {
    currentCookie.sessionToken = undefined;
    const signal = await callAndCaptureRedirect(() => updateWritingStyleAction());
    expect(signal.url).toBe("/login");
  });
});

// ---------------------------------------------------------------------------
// updateWritingStyleAction — mocked failure/success paths
// ---------------------------------------------------------------------------

describe("updateWritingStyleAction — failure paths change nothing", () => {
  it("zero exemplars: redirects with a clear error, writes nothing (never even reaches the Claude client)", async () => {
    await asManager("commissioner");
    const before = db.select().from(recapStyleGuides).all().length;

    const signal = await callAndCaptureRedirect(() => updateWritingStyleAction());
    expect(signal.url).toContain("/admin/recaps/voice?error=");
    expect(decodeURIComponent(signal.url)).toContain("No revised recaps yet");
    expect(db.select().from(recapStyleGuides).all().length).toBe(before);
  });

  it("no ANTHROPIC_API_KEY configured (with an exemplar present): redirects with a clear error, writes nothing", async () => {
    const recap = db
      .insert(recaps)
      .values({ season: SEASON, week: 90, style: "dry-coach", status: "published", factsJson: {}, markdownDraft: "final", markdownGenerated: "original" })
      .returning()
      .get();
    db.insert(recapExemplars).values({ recapId: recap.id, season: SEASON, week: 90, style: "dry-coach", draftMd: "original", publishedMd: "final", capturedAt: new Date() }).run();

    await asManager("commissioner");
    const before = db.select().from(recapStyleGuides).all().length;
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const signal = await callAndCaptureRedirect(() => updateWritingStyleAction());
      expect(signal.url).toContain("/admin/recaps/voice?error=");
      expect(decodeURIComponent(signal.url)).toContain("No Claude API key");
    } finally {
      if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
    }
    expect(db.select().from(recapStyleGuides).all().length).toBe(before);
  });
});

describe("updateWritingStyleAction — mocked success path", () => {
  it("with an exemplar present and a mocked Claude response, stores the guide and redirects with success", async () => {
    const recap = db
      .insert(recaps)
      .values({ season: SEASON, week: 91, style: "dry-coach", status: "published", factsJson: {}, markdownDraft: "final v2", markdownGenerated: "original v2" })
      .returning()
      .get();
    db.insert(recapExemplars).values({ recapId: recap.id, season: SEASON, week: 91, style: "dry-coach", draftMd: "original v2", publishedMd: "final v2", capturedAt: new Date() }).run();

    await asManager("commissioner");
    process.env.ANTHROPIC_API_KEY = "test-key-not-used-for-real-calls";
    mockFinalMessage = {
      content: [{ type: "text", text: "- Cut the throat-clearing intro.\n- Lean into deadpan understatement." }],
      usage: { input_tokens: 123, output_tokens: 45 },
    };

    const signal = await callAndCaptureRedirect(() => updateWritingStyleAction());
    expect(signal.url).toContain("/admin/recaps/voice?success=extracted");

    const active = db.select().from(recapStyleGuides).where(eq(recapStyleGuides.isActive, true)).get();
    expect(active?.guideText).toBe("- Cut the throat-clearing intro.\n- Lean into deadpan understatement.");
    expect(active?.model).toBe("claude-opus-5");
    expect(active?.tokensIn).toBe(123);
    expect(active?.tokensOut).toBe(45);

    delete process.env.ANTHROPIC_API_KEY;
  });
});
