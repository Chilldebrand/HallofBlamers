/**
 * `npm run seed:suggest` — bootstrap helper that scans every archived
 * season-scope snapshot and prints a draft `seed/franchises.json` grouping
 * ESPN teams by owner SWID across seasons. A human should review the output
 * before saving it as the real `seed/franchises.json` (see franchise-map.ts).
 */
import { pathToFileURL } from "node:url";
import { getDb } from "../db/client";
import { runMigrations } from "../db/migrate";
import { suggestFranchises, suggestionsToSeedJson } from "./franchise-map";

export function main(): void {
  const db = getDb();
  runMigrations(db);

  const suggestions = suggestFranchises(db);
  if (suggestions.length === 0) {
    console.log("No season-scope snapshots archived yet — nothing to suggest. Run `npm run backfill` first.");
    return;
  }

  console.log(suggestionsToSeedJson(suggestions));
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  main();
}
