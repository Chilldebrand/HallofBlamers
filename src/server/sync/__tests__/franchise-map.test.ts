import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { franchiseManagers, franchises } from "../../db/schema";
import {
  applyFranchiseSeed,
  loadFranchiseSeed,
  resolveFranchise,
  suggestFranchises,
  suggestionsToSeedJson,
  type FranchiseSeed,
} from "../franchise-map";
import { SEASON_SCOPE_VIEW_KEY } from "../espn-shapes";
import { storeSnapshot } from "../snapshots";

function twoFranchiseSeed(): FranchiseSeed {
  return {
    franchises: [
      {
        id: 1,
        canonicalName: "Franchise One",
        managerName: "Alice",
        joinedSeason: 2020,
        departedSeason: null,
        active: true,
        accentColor: null,
        notes: null,
        managers: [{ managerName: "Alice", espnOwnerSwid: "{SWID-A}", fromSeason: 2020, toSeason: 2022 }],
        espnTeamIds: [{ season: 2020, espnTeamId: 10 }],
      },
      {
        id: 2,
        canonicalName: "Franchise Two",
        managerName: "Bob",
        joinedSeason: 2020,
        departedSeason: null,
        active: true,
        accentColor: null,
        notes: null,
        managers: [{ managerName: "Bob", espnOwnerSwid: "{SWID-B}", fromSeason: 2023, toSeason: null }],
        espnTeamIds: [],
      },
    ],
  };
}

describe("resolveFranchise", () => {
  it("prefers an explicit (season, espnTeamId) mapping over an ownerSwid match", () => {
    const seed: FranchiseSeed = {
      franchises: [
        {
          id: 1,
          canonicalName: "F1",
          managerName: "A",
          joinedSeason: 2020,
          departedSeason: null,
          active: true,
          accentColor: null,
          notes: null,
          managers: [{ managerName: "A", espnOwnerSwid: "{SWID-X}", fromSeason: 2020, toSeason: null }],
          espnTeamIds: [],
        },
        {
          id: 2,
          canonicalName: "F2",
          managerName: "B",
          joinedSeason: 2020,
          departedSeason: null,
          active: true,
          accentColor: null,
          notes: null,
          managers: [],
          espnTeamIds: [{ season: 2020, espnTeamId: 5 }],
        },
      ],
    };
    // Team 5, owned by SWID-X: F1 would match via ownerSwid, but F2's explicit mapping wins.
    expect(resolveFranchise(seed, 2020, 5, ["{SWID-X}"])).toBe(2);
  });

  it("falls back to an ownerSwid match respecting [fromSeason, toSeason]", () => {
    const seed = twoFranchiseSeed();
    expect(resolveFranchise(seed, 2021, 999, ["{SWID-A}"])).toBe(1); // within window
    expect(resolveFranchise(seed, 2023, 999, ["{SWID-A}"])).toBeNull(); // after toSeason=2022
    expect(resolveFranchise(seed, 2019, 999, ["{SWID-A}"])).toBeNull(); // before fromSeason=2020
    expect(resolveFranchise(seed, 2023, 999, ["{SWID-B}"])).toBe(2); // open-ended toSeason
  });

  it("returns null when nothing matches", () => {
    const seed = twoFranchiseSeed();
    expect(resolveFranchise(seed, 2020, 999, ["{SWID-UNKNOWN}"])).toBeNull();
    expect(resolveFranchise(seed, 2020, 999, [])).toBeNull();
  });
});

describe("loadFranchiseSeed", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-franchise-seed-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty seed with a warning when the file doesn't exist", () => {
    const result = loadFranchiseSeed(path.join(tmpDir, "missing.json"));
    expect(result.seed.franchises).toEqual([]);
    expect(result.warnings.some((w) => w.includes("not found"))).toBe(true);
  });

  it("throws on invalid JSON", () => {
    const p = path.join(tmpDir, "franchises.json");
    fs.writeFileSync(p, "{not json");
    expect(() => loadFranchiseSeed(p)).toThrow(/not valid JSON/);
  });

  it("throws when the top-level franchises array is missing", () => {
    const p = path.join(tmpDir, "franchises.json");
    fs.writeFileSync(p, JSON.stringify({ notFranchises: [] }));
    expect(() => loadFranchiseSeed(p)).toThrow(/top-level "franchises" array/);
  });

  it("parses a valid file and skips a malformed entry with a warning", () => {
    const p = path.join(tmpDir, "franchises.json");
    fs.writeFileSync(
      p,
      JSON.stringify({
        franchises: [
          { id: 1, canonicalName: "Good", managerName: "A", joinedSeason: 2020, managers: [], espnTeamIds: [] },
          { canonicalName: "Missing id and joinedSeason" },
        ],
      }),
    );
    const result = loadFranchiseSeed(p);
    expect(result.seed.franchises).toHaveLength(1);
    expect(result.seed.franchises[0]?.canonicalName).toBe("Good");
    expect(result.warnings.some((w) => w.includes("skipped"))).toBe(true);
  });
});

describe("applyFranchiseSeed + suggestFranchises (DB-backed)", () => {
  let tmpDir: string;
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-franchise-db-test-"));
    const opened = createDb(path.join(tmpDir, "test.db"));
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("upserts franchises + franchise_managers by explicit id, idempotently", () => {
    const seed = twoFranchiseSeed();
    applyFranchiseSeed(db, seed);
    applyFranchiseSeed(db, seed); // second call must not duplicate anything

    const franchiseRows = db.select().from(franchises).all();
    expect(franchiseRows).toHaveLength(2);
    expect(franchiseRows.map((f) => f.id).sort()).toEqual([1, 2]);

    const managerRows = db.select().from(franchiseManagers).where(eq(franchiseManagers.franchiseId, 1)).all();
    expect(managerRows).toHaveLength(1);
    expect(managerRows[0]?.espnOwnerSwid).toBe("{SWID-A}");
  });

  it("fully replaces a franchise's managers on re-apply (delete-then-reinsert)", () => {
    const seed = twoFranchiseSeed();
    applyFranchiseSeed(db, seed);

    const updated = twoFranchiseSeed();
    updated.franchises[0]!.managers = [
      { managerName: "Alice", espnOwnerSwid: "{SWID-A}", fromSeason: 2020, toSeason: 2022 },
      { managerName: "Carol", espnOwnerSwid: "{SWID-C}", fromSeason: 2023, toSeason: null },
    ];
    applyFranchiseSeed(db, updated);

    const managerRows = db.select().from(franchiseManagers).where(eq(franchiseManagers.franchiseId, 1)).all();
    expect(managerRows).toHaveLength(2);
    expect(managerRows.map((m) => m.espnOwnerSwid).sort()).toEqual(["{SWID-A}", "{SWID-C}"]);
  });

  it("updates a franchise's own fields in place on re-apply", () => {
    const seed = twoFranchiseSeed();
    applyFranchiseSeed(db, seed);

    const renamed = twoFranchiseSeed();
    renamed.franchises[0]!.canonicalName = "Renamed Franchise";
    applyFranchiseSeed(db, renamed);

    const row = db.select().from(franchises).where(eq(franchises.id, 1)).get();
    expect(row?.canonicalName).toBe("Renamed Franchise");
    expect(db.select().from(franchises).all()).toHaveLength(2); // still exactly 2, not 3
  });

  it("suggestFranchises groups teams by primary owner SWID across seasons", () => {
    const season2023 = {
      settings: { name: "L" },
      status: {},
      teams: [
        { id: 1, name: "Alpha Team", owners: ["{SWID-A}"] },
        { id: 2, name: "No Owner Team", owners: [] },
      ],
      members: [{ id: "{SWID-A}", displayName: "Alice" }],
    };
    const season2024 = {
      settings: { name: "L" },
      status: {},
      teams: [{ id: 5, name: "Alpha Team Renamed", owners: ["{SWID-A}"] }],
      members: [{ id: "{SWID-A}", displayName: "Alice" }],
    };
    storeSnapshot(db, {
      season: 2023,
      scoringPeriod: null,
      view: SEASON_SCOPE_VIEW_KEY,
      url: "x",
      httpStatus: 200,
      payload: JSON.stringify(season2023),
    });
    storeSnapshot(db, {
      season: 2024,
      scoringPeriod: null,
      view: SEASON_SCOPE_VIEW_KEY,
      url: "x",
      httpStatus: 200,
      payload: JSON.stringify(season2024),
    });

    const suggestions = suggestFranchises(db);
    const alpha = suggestions.find((s) => s.groupKey === "{SWID-A}");
    expect(alpha).toBeDefined();
    expect(alpha?.seasonsSeen).toEqual([2023, 2024]);
    expect(alpha?.espnTeamIds).toEqual([
      { season: 2023, espnTeamId: 1 },
      { season: 2024, espnTeamId: 5 },
    ]);
    expect(alpha?.displayName).toBe("Alice");
    expect(alpha?.teamNames).toEqual(["Alpha Team", "Alpha Team Renamed"]);

    const noOwner = suggestions.find((s) => s.groupKey === "no-owner:2023:2");
    expect(noOwner).toBeDefined();
    expect(noOwner?.seasonsSeen).toEqual([2023]);

    const json = suggestionsToSeedJson(suggestions);
    const parsed = JSON.parse(json) as FranchiseSeed;
    expect(parsed.franchises.length).toBe(suggestions.length);
    expect(parsed.franchises.every((f) => typeof f.id === "number")).toBe(true);
  });
});
