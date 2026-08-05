/**
 * requireCommissioner() end-to-end: /admin is the FIRST real commissioner
 * mutation surface, so this proves the guard actually rejects a
 * manager-role session at the Server Action itself (not just at
 * assertCommissioner() in isolation — guard.test.ts already covers that
 * pure piece). Mocks next/headers/next/navigation (Server Action-only APIs
 * that don't work outside a real Next.js request) and points the db/client
 * singleton at a seeded temp DB, mirroring src/server/queries/__tests__/
 * db-integration.test.ts's established pattern.
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

// testEspnConnectionAction's default (no injected client) path constructs a real EspnClient — for
// the commissioner-accepted tests below (never for the rejection tests, which never reach this
// far), mock ONLY the client's network call so no real HTTP request is ever made from this test
// file. Keeps every other real export (EspnAuthError etc.) so `instanceof` checks inside
// espn-connection.ts's catch block still work against the SAME class the test imports.
const espnFetchLeagueMock = vi.fn();
class MockEspnClient {
  fetchLeague(...args: unknown[]) {
    return espnFetchLeagueMock(...args);
  }
}
vi.mock("@/server/espn/client", async () => {
  const actual = await vi.importActual<typeof import("../../../server/espn/client")>("../../../server/espn/client");
  return {
    ...actual,
    EspnClient: MockEspnClient,
  };
});

const { createDb, getSqlite } = await import("../../../server/db/client");
const { runMigrations } = await import("../../../server/db/migrate");
const { appSettings, managers } = await import("../../../server/db/schema");
const { createSessionToken } = await import("../../../server/auth/session");
const { EspnAuthError } = await import("../../../server/espn/client");
const { setDraftDate, regenerateInviteLink, addManager, saveEspnCookiesAction, testEspnConnectionAction } = await import("../actions");

type Db = Awaited<ReturnType<typeof createDb>>["db"];

let db: Db;
let sqlite: Database.Database;
let dbPath: string;

beforeAll(() => {
  process.env.SESSION_SECRET = "a".repeat(32);
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-admin-action-test-")), "test.db");
  process.env.DATABASE_PATH = dbPath;
  const opened = createDb(dbPath);
  db = opened.db;
  sqlite = opened.sqlite;
  runMigrations(db);
});

afterAll(() => {
  sqlite.close();
  // setDraftDate/regenerateInviteLink/addManager go through db/client.ts's separate lazy
  // singleton connection (same file, second handle) — has to be closed too or Windows holds a
  // lock on the temp directory.
  getSqlite().close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

afterEach(() => {
  db.delete(appSettings).run();
  currentCookie.sessionToken = undefined;
  espnFetchLeagueMock.mockReset();
});

async function callAndCaptureRedirect(fn: () => Promise<void>): Promise<RedirectSignal> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof RedirectSignal) return e;
    throw e;
  }
  throw new Error("expected a redirect, but the action returned normally");
}

describe("setDraftDate — requireCommissioner end-to-end", () => {
  it("rejects a manager-role session: redirects home, never writes app_settings", async () => {
    const manager = db.insert(managers).values({ name: "Manager", role: "manager", inviteToken: "tok-reject-1" }).returning().get();
    currentCookie.sessionToken = await createSessionToken(manager.id);

    const formData = new FormData();
    formData.set("draftDate", "2027-01-01");

    const signal = await callAndCaptureRedirect(() => setDraftDate(formData));
    expect(signal.url).toBe("/");

    const row = db.select().from(appSettings).where(eq(appSettings.key, "draft_date")).get();
    expect(row).toBeUndefined();
  });

  it("accepts a commissioner-role session: redirects to /admin, writes app_settings", async () => {
    const manager = db.insert(managers).values({ name: "Commish", role: "commissioner", inviteToken: "tok-accept-1" }).returning().get();
    currentCookie.sessionToken = await createSessionToken(manager.id);

    const formData = new FormData();
    formData.set("draftDate", "2027-01-01");

    const signal = await callAndCaptureRedirect(() => setDraftDate(formData));
    expect(signal.url).toBe("/admin?success=draft_date");

    const row = db.select().from(appSettings).where(eq(appSettings.key, "draft_date")).get();
    expect(row?.valueJson).toBe("2027-01-01");
  });

  it("rejects an unauthenticated request (no session cookie at all)", async () => {
    currentCookie.sessionToken = undefined;
    const formData = new FormData();
    formData.set("draftDate", "2027-01-01");

    const signal = await callAndCaptureRedirect(() => setDraftDate(formData));
    expect(signal.url).toBe("/login");
  });
});

describe("regenerateInviteLink / addManager — same guard, same rejection", () => {
  it("regenerateInviteLink rejects a manager-role session and never rotates the token", async () => {
    const target = db.insert(managers).values({ name: "Target", role: "manager", inviteToken: "original-token" }).returning().get();
    const caller = db.insert(managers).values({ name: "Caller", role: "manager", inviteToken: "tok-reject-2" }).returning().get();
    currentCookie.sessionToken = await createSessionToken(caller.id);

    const formData = new FormData();
    formData.set("managerId", String(target.id));

    const signal = await callAndCaptureRedirect(() => regenerateInviteLink(formData));
    expect(signal.url).toBe("/");

    const row = db.select().from(managers).where(eq(managers.id, target.id)).get();
    expect(row?.inviteToken).toBe("original-token");
  });

  it("addManager rejects a manager-role session and never inserts a row", async () => {
    const caller = db.insert(managers).values({ name: "Caller2", role: "manager", inviteToken: "tok-reject-3" }).returning().get();
    currentCookie.sessionToken = await createSessionToken(caller.id);

    const before = db.select().from(managers).all().length;

    const formData = new FormData();
    formData.set("name", "New Manager");
    formData.set("role", "manager");
    formData.set("franchiseId", "");

    const signal = await callAndCaptureRedirect(() => addManager(formData));
    expect(signal.url).toBe("/");

    const after = db.select().from(managers).all().length;
    expect(after).toBe(before);
  });
});

const REAL_SWID = "{ABCDEF12-3456-7890-ABCD-EF1234567890}";
const REAL_S2 = "A".repeat(120);

describe("saveEspnCookiesAction — requireCommissioner end-to-end", () => {
  it("rejects a manager-role session: redirects home, never writes app_settings", async () => {
    const manager = db.insert(managers).values({ name: "Manager3", role: "manager", inviteToken: "tok-espn-reject-1" }).returning().get();
    currentCookie.sessionToken = await createSessionToken(manager.id);

    const formData = new FormData();
    formData.set("espnS2", REAL_S2);
    formData.set("swid", REAL_SWID);

    const signal = await callAndCaptureRedirect(() => saveEspnCookiesAction(formData));
    expect(signal.url).toBe("/");
    expect(db.select().from(appSettings).where(eq(appSettings.key, "espn_s2")).get()).toBeUndefined();
    expect(db.select().from(appSettings).where(eq(appSettings.key, "swid")).get()).toBeUndefined();
  });

  it("rejects an unauthenticated request", async () => {
    currentCookie.sessionToken = undefined;
    const formData = new FormData();
    formData.set("espnS2", REAL_S2);
    formData.set("swid", REAL_SWID);

    const signal = await callAndCaptureRedirect(() => saveEspnCookiesAction(formData));
    expect(signal.url).toBe("/login");
  });

  it("rejects a malformed SWID (no braces) and never writes anything", async () => {
    const manager = db.insert(managers).values({ name: "Commish1", role: "commissioner", inviteToken: "tok-espn-badswid" }).returning().get();
    currentCookie.sessionToken = await createSessionToken(manager.id);

    const formData = new FormData();
    formData.set("espnS2", REAL_S2);
    formData.set("swid", "ABCDEF12-3456-7890-ABCD-EF1234567890"); // no braces

    const signal = await callAndCaptureRedirect(() => saveEspnCookiesAction(formData));
    expect(signal.url).toMatch(/^\/admin\?error=/);
    expect(db.select().from(appSettings).where(eq(appSettings.key, "swid")).get()).toBeUndefined();
  });

  it("accepts a commissioner-role session: writes BOTH keys verbatim, braces and all, no decoding", async () => {
    const manager = db.insert(managers).values({ name: "Commish2", role: "commissioner", inviteToken: "tok-espn-accept" }).returning().get();
    currentCookie.sessionToken = await createSessionToken(manager.id);

    const encodedLookingS2 = `${"B".repeat(60)}%2F%3D${"C".repeat(60)}`;
    const formData = new FormData();
    formData.set("espnS2", encodedLookingS2);
    formData.set("swid", REAL_SWID);

    const signal = await callAndCaptureRedirect(() => saveEspnCookiesAction(formData));
    expect(signal.url).toBe("/admin?success=espn_cookies");

    const s2Row = db.select().from(appSettings).where(eq(appSettings.key, "espn_s2")).get();
    const swidRow = db.select().from(appSettings).where(eq(appSettings.key, "swid")).get();
    // Verbatim — the %2F/%3D sequences are NOT decoded, and the braces are NOT stripped.
    expect(s2Row?.valueJson).toBe(encodedLookingS2);
    expect(swidRow?.valueJson).toBe(REAL_SWID);
  });

  it("a subsequent save OVERWRITES the previously stored cookies (rotation, not accumulation)", async () => {
    const manager = db.insert(managers).values({ name: "Commish3", role: "commissioner", inviteToken: "tok-espn-rotate" }).returning().get();
    currentCookie.sessionToken = await createSessionToken(manager.id);

    const first = new FormData();
    first.set("espnS2", REAL_S2);
    first.set("swid", REAL_SWID);
    await callAndCaptureRedirect(() => saveEspnCookiesAction(first));

    const newSwid = "{11111111-2222-3333-4444-555555555555}";
    const second = new FormData();
    second.set("espnS2", "D".repeat(80));
    second.set("swid", newSwid);
    await callAndCaptureRedirect(() => saveEspnCookiesAction(second));

    const swidRow = db.select().from(appSettings).where(eq(appSettings.key, "swid")).get();
    expect(swidRow?.valueJson).toBe(newSwid);
    const allSwidRows = db.select().from(appSettings).where(eq(appSettings.key, "swid")).all();
    expect(allSwidRows).toHaveLength(1); // upsert, not a second row
  });
});

describe("testEspnConnectionAction — requireCommissioner end-to-end + mocked ESPN client", () => {
  it("rejects a manager-role session — never calls the ESPN client at all", async () => {
    const manager = db.insert(managers).values({ name: "Manager4", role: "manager", inviteToken: "tok-test-reject-1" }).returning().get();
    currentCookie.sessionToken = await createSessionToken(manager.id);

    const formData = new FormData();
    formData.set("espnS2", REAL_S2);
    formData.set("swid", REAL_SWID);

    const signal = await callAndCaptureRedirect(() => testEspnConnectionAction(formData));
    expect(signal.url).toBe("/");
    expect(espnFetchLeagueMock).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated request", async () => {
    currentCookie.sessionToken = undefined;
    const formData = new FormData();
    const signal = await callAndCaptureRedirect(() => testEspnConnectionAction(formData));
    expect(signal.url).toBe("/login");
    expect(espnFetchLeagueMock).not.toHaveBeenCalled();
  });

  it("commissioner, success path: redirects with the league name, never with cookie values in the URL", async () => {
    const manager = db.insert(managers).values({ name: "Commish4", role: "commissioner", inviteToken: "tok-test-success" }).returning().get();
    currentCookie.sessionToken = await createSessionToken(manager.id);
    db.insert(appSettings).values({ key: "espn_league_id", valueJson: 1690915927, updatedAt: new Date() }).run();
    espnFetchLeagueMock.mockResolvedValueOnce({ json: { settings: { name: "Hall of Blamers" } } });

    const formData = new FormData();
    formData.set("espnS2", REAL_S2);
    formData.set("swid", REAL_SWID);

    const signal = await callAndCaptureRedirect(() => testEspnConnectionAction(formData));
    expect(signal.url).toContain("test=success");
    expect(signal.url).toContain(encodeURIComponent("Hall of Blamers"));
    expect(signal.url).not.toContain(REAL_S2);
    expect(signal.url).not.toContain(encodeURIComponent(REAL_SWID));
  });

  it("commissioner, auth-fail path: redirects with test=error and a helpful (never cookie-echoing) message", async () => {
    const manager = db.insert(managers).values({ name: "Commish5", role: "commissioner", inviteToken: "tok-test-authfail" }).returning().get();
    currentCookie.sessionToken = await createSessionToken(manager.id);
    db.insert(appSettings).values({ key: "espn_league_id", valueJson: 1690915927, updatedAt: new Date() }).run();
    espnFetchLeagueMock.mockRejectedValueOnce(new EspnAuthError(401, "https://example.com/leagues/1690915927"));

    const formData = new FormData();
    formData.set("espnS2", REAL_S2);
    formData.set("swid", REAL_SWID);

    const signal = await callAndCaptureRedirect(() => testEspnConnectionAction(formData));
    expect(signal.url).toContain("test=error");
    expect(signal.url).not.toContain(REAL_S2);
    expect(signal.url).not.toContain(encodeURIComponent(REAL_SWID));
  });

  it("falls back to the STORED cookies when both fields are submitted blank", async () => {
    const manager = db.insert(managers).values({ name: "Commish6", role: "commissioner", inviteToken: "tok-test-stored" }).returning().get();
    currentCookie.sessionToken = await createSessionToken(manager.id);
    db.insert(appSettings).values({ key: "espn_league_id", valueJson: 1690915927, updatedAt: new Date() }).run();
    db.insert(appSettings).values({ key: "espn_s2", valueJson: REAL_S2, updatedAt: new Date() }).run();
    db.insert(appSettings).values({ key: "swid", valueJson: REAL_SWID, updatedAt: new Date() }).run();
    espnFetchLeagueMock.mockResolvedValueOnce({ json: { settings: { name: "Stored-Cookie League" } } });

    const formData = new FormData(); // espnS2/swid deliberately left unset
    const signal = await callAndCaptureRedirect(() => testEspnConnectionAction(formData));
    expect(signal.url).toContain("test=success");
    expect(signal.url).toContain(encodeURIComponent("Stored-Cookie League"));
  });

  it("no submitted AND no stored cookies: a clear error, never a network attempt", async () => {
    const manager = db.insert(managers).values({ name: "Commish7", role: "commissioner", inviteToken: "tok-test-nocreds" }).returning().get();
    currentCookie.sessionToken = await createSessionToken(manager.id);

    const formData = new FormData();
    const signal = await callAndCaptureRedirect(() => testEspnConnectionAction(formData));
    expect(signal.url).toContain("test=error");
    expect(espnFetchLeagueMock).not.toHaveBeenCalled();
  });
});
