/**
 * `npm run seed:managers` — upserts manager rows from `seed/managers.json`
 * (name, franchiseId, role), generating a fresh crypto UUID invite_token for
 * any new manager, and PRINTS every /join/<token> invite link to the
 * console. Idempotent: re-running it keeps existing managers' tokens (so
 * links already sent out don't break) and just refreshes franchiseId/role.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { runMigrations } from "../db/migrate";
import { managers } from "../db/schema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_PATH = path.join(__dirname, "../../../seed/managers.json");

export interface SeedManager {
  name: string;
  franchiseId: number | null;
  role: "commissioner" | "manager";
}

interface SeedFile {
  managers: SeedManager[];
}

export function loadSeedManagers(seedPath: string = SEED_PATH): SeedManager[] {
  const raw = fs.readFileSync(seedPath, "utf-8");
  const parsed = JSON.parse(raw) as SeedFile;
  return parsed.managers;
}

export function main(): void {
  const db = getDb();
  runMigrations(db);

  const seedManagers = loadSeedManagers();
  if (seedManagers.length === 0) {
    console.log("seed/managers.json has no managers — nothing to do.");
    return;
  }

  console.log("Invite links:");
  for (const entry of seedManagers) {
    const existing = db.select().from(managers).where(eq(managers.name, entry.name)).get();
    const inviteToken = existing?.inviteToken ?? randomUUID();

    if (existing) {
      db.update(managers)
        .set({ franchiseId: entry.franchiseId, role: entry.role })
        .where(eq(managers.id, existing.id))
        .run();
    } else {
      db.insert(managers)
        .values({ name: entry.name, franchiseId: entry.franchiseId, role: entry.role, inviteToken })
        .run();
    }

    console.log(`  ${entry.name} (${entry.role}): /join/${inviteToken}`);
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  main();
}
