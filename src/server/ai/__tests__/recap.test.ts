/**
 * `generateRecap` against a seeded temp DB with an INJECTED MOCK Claude client — the real
 * Anthropic API is never called, in this file or anywhere else in this task (binding rule; see
 * task-13-brief.md's final line). `renderFallbackRecap` is exercised separately here too since it
 * needs no client at all.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { franchises, leagues, matchups, recaps, seasons, statBuilds, teamSeasons, teamWeek, weeks, type Recap } from "@/server/db/schema";
import { buildWeekFacts } from "../facts";
import {
  buildSystemPrompt,
  buildUserPrompt,
  computeCostUsd,
  generateRecap,
  RECAP_CLIENT_MAX_RETRIES,
  RECAP_MAX_TOKENS,
  RECAP_MODEL,
  RecapApiKeyMissingError,
  RecapInvalidStyleError,
  renderFallbackRecap,
  type RecapAnthropicClient,
  type RecapFinalMessage,
} from "../recap";
import { RECAP_STYLES } from "../styles";

let db: Db;
let sqlite: Database.Database;
let dbPath: string;
const SEASON = 2024;
let f1: number;
let f2: number;

beforeAll(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-recap-test-")), "test.db");
  const opened = createDb(dbPath);
  db = opened.db;
  sqlite = opened.sqlite;
  runMigrations(db);

  const league = db.insert(leagues).values({ espnLeagueId: 1, name: "Test League", firstSeason: SEASON }).returning().get();
  db.insert(seasons)
    .values({ season: SEASON, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 2, regSeasonWeeks: 14, status: "active" })
    .run();
  f1 = db.insert(franchises).values({ canonicalName: "Gridiron Gladiators", managerName: "Zoe", joinedSeason: SEASON, active: true }).returning().get().id;
  f2 = db.insert(franchises).values({ canonicalName: "Blue Thunder", managerName: "Bob", joinedSeason: SEASON, active: true }).returning().get().id;
  const ts1 = db
    .insert(teamSeasons)
    .values({ season: SEASON, franchiseId: f1, espnTeamId: 1, teamName: "Gladiators", wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, finalStanding: 0, madePlayoffs: false })
    .returning()
    .get().id;
  const ts2 = db
    .insert(teamSeasons)
    .values({ season: SEASON, franchiseId: f2, espnTeamId: 2, teamName: "Thunder", wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, finalStanding: 0, madePlayoffs: false })
    .returning()
    .get().id;
  db.insert(weeks).values({ season: SEASON, week: 1, scoringPeriodId: 1, weekType: "regular", isComplete: true }).run();
  db.insert(matchups)
    .values({ season: SEASON, week: 1, espnMatchupId: 1, homeTeamSeasonId: ts1, awayTeamSeasonId: ts2, homeScore: 130, awayScore: 100, isFinal: true, winner: "home" })
    .run();
  const buildId = db.insert(statBuilds).values({ startedAt: new Date(), inputHash: "test", status: "ok" }).returning().get().id;
  db.insert(teamWeek)
    .values([{ buildId, season: SEASON, week: 1, weekType: "regular", teamSeasonId: ts1, franchiseId: f1, opponentFranchiseId: f2, score: 130, result: "W", margin: 30 }])
    .run();
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

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

describe("generateRecap — prompt assembly", () => {
  it("includes the guardrail block, the style fragment, and the facts JSON in the request", async () => {
    const { client, calls } = mockClient({
      content: [{ type: "text", text: "# Week 1 Recap\n\nGridiron Gladiators won." }],
      usage: { input_tokens: 1200, output_tokens: 300 },
    });

    await generateRecap({ db, season: SEASON, week: 1, styleId: "trash-talk", client });

    expect(calls).toHaveLength(1);
    const call = calls[0] as { model: string; max_tokens: number; system: string; messages: { role: string; content: string }[] };
    expect(call.model).toBe(RECAP_MODEL);
    expect(call.max_tokens).toBe(RECAP_MAX_TOKENS);
    expect(call.system).toContain("Every number, player name, and historical claim");
    expect(call.system).toContain(RECAP_STYLES.find((s) => s.id === "trash-talk")!.systemFragment);
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0]!.role).toBe("user");
    expect(call.messages[0]!.content).toContain('"season": 2024');
    expect(call.messages[0]!.content).toContain('"week": 1');
  });

  it("buildSystemPrompt / buildUserPrompt expose the exact assembled strings for direct assertion", () => {
    const facts = buildWeekFacts(db, SEASON, 1);
    const style = RECAP_STYLES.find((s) => s.id === "league-historian")!;
    const system = buildSystemPrompt(style);
    const user = buildUserPrompt(facts);
    expect(system).toContain("Never mention player injuries");
    expect(system).toContain(style.systemFragment);
    expect(user).toContain(JSON.stringify(facts, null, 2).slice(0, 40));
  });
});

describe("generateRecap — stores the row with cost math", () => {
  it("computes cost from usage and stores a new draft row", async () => {
    const { client } = mockClient({
      content: [{ type: "text", text: "# Week 1 Recap\n\nA great week." }],
      usage: { input_tokens: 2000, output_tokens: 500 },
    });

    const before = db.select().from(recaps).all().length;
    const row: Recap = await generateRecap({ db, season: SEASON, week: 1, styleId: "serious-analyst", client });
    const after = db.select().from(recaps).all().length;

    expect(after).toBe(before + 1);
    expect(row.status).toBe("draft");
    expect(row.markdownDraft).toBe("# Week 1 Recap\n\nA great week.");
    expect(row.markdownFinal).toBeNull();
    expect(row.tokensIn).toBe(2000);
    expect(row.tokensOut).toBe(500);
    expect(row.costUsd).toBeCloseTo(computeCostUsd(2000, 500), 10);
    expect(row.model).toBe(RECAP_MODEL);
    expect(row.style).toBe("serious-analyst");

    const persisted = db.select().from(recaps).where(eq(recaps.id, row.id)).get();
    expect(persisted?.factsJson).toBeTruthy();
  });

  it("concatenates multiple text blocks and ignores non-text (e.g. thinking) blocks", async () => {
    const { client } = mockClient({
      content: [
        { type: "thinking", text: "internal reasoning that must never end up in the draft" },
        { type: "text", text: "# Week 1 Recap" },
        { type: "text", text: "Second paragraph." },
      ],
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    const row = await generateRecap({ db, season: SEASON, week: 1, styleId: "dry-coach", client });
    expect(row.markdownDraft).toBe("# Week 1 Recap\n\nSecond paragraph.");
    expect(row.markdownDraft).not.toContain("internal reasoning");
  });

  it("cost math: $5/MTok input, $25/MTok output", () => {
    expect(computeCostUsd(1_000_000, 0)).toBeCloseTo(5, 10);
    expect(computeCostUsd(0, 1_000_000)).toBeCloseTo(25, 10);
    expect(computeCostUsd(500_000, 200_000)).toBeCloseTo(2.5 + 5, 10);
  });
});

describe("generateRecap — error paths", () => {
  it("throws RecapInvalidStyleError for an unknown style id, before ever touching the client", async () => {
    let clientCalled = false;
    const client: RecapAnthropicClient = {
      messages: {
        stream() {
          clientCalled = true;
          throw new Error("should never be called");
        },
      },
    };
    await expect(generateRecap({ db, season: SEASON, week: 1, styleId: "not-a-real-style", client })).rejects.toThrow(RecapInvalidStyleError);
    expect(clientCalled).toBe(false);
  });

  it("propagates RecapIncompleteWeekError from buildWeekFacts for an incomplete week", async () => {
    const { client } = mockClient({ content: [{ type: "text", text: "x" }], usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(generateRecap({ db, season: SEASON, week: 99, styleId: "dry-coach", client })).rejects.toThrow();
  });

  it("throws RecapApiKeyMissingError when no client is injected and ANTHROPIC_API_KEY is unset", async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(generateRecap({ db, season: SEASON, week: 1, styleId: "dry-coach" })).rejects.toThrow(RecapApiKeyMissingError);
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    }
  });
});

describe("generateRecap — retry config", () => {
  it("RECAP_CLIENT_MAX_RETRIES is 4, per the brief's explicit client construction requirement", () => {
    expect(RECAP_CLIENT_MAX_RETRIES).toBe(4);
  });
});

describe("renderFallbackRecap — deterministic, no client involved", () => {
  it("is a pure function of facts: identical facts produce byte-identical markdown", () => {
    const facts = buildWeekFacts(db, SEASON, 1);
    expect(renderFallbackRecap(facts)).toBe(renderFallbackRecap(facts));
  });

  it("snapshot: matches the expected deterministic template shape", () => {
    const facts = buildWeekFacts(db, SEASON, 1);
    const markdown = renderFallbackRecap(facts);
    expect(markdown).toMatchSnapshot();
  });
});
