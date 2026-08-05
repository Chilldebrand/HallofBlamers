# seed/corrections/

Manual corrections for known-bad ESPN data — the third input to the
normalizer's pure rebuild function (`raw snapshots + seed files + corrections
-> normalized tables`, see `AGENTS.md`). Corrections are applied LAST, after
a season's layer-2 tables are fully rebuilt from snapshots, so they survive
every re-run of `npm run normalize`.

## File format

Every `*.json` file in this directory (except `*.example.json`, which is
never loaded) must be a top-level JSON **array** of correction objects:

```json
[
  {
    "targetTable": "matchups",
    "targetKey": { "season": 2023, "week": 4, "espn_matchup_id": 2 },
    "field": "home_score",
    "value": 118.4,
    "reason": "ESPN's live score never settled after a stat correction; commissioner confirmed the final box score.",
    "createdBy": "commissioner@example.com",
    "active": true
  }
]
```

- `targetTable` — one of the layer-2 table names (`leagues`, `seasons`,
  `franchises`, `franchise_managers`, `team_seasons`, `weeks`, `matchups`,
  `players`, `roster_slots`, `transactions`, `transaction_items`,
  `draft_picks`). Any other table is rejected with a warning, not applied.
- `targetKey` — an object of **DB column name** (snake_case) -> value,
  ANDed together to locate exactly one row. Use natural/business keys that
  survive a rebuild (e.g. `season`/`week`/`espn_matchup_id`), never the
  surrogate `id` column — `id` is reassigned every time the normalizer
  deletes and rebuilds a season, so a correction keyed on `id` would silently
  stop matching after the very next normalize run.
- `field` — the DB column (snake_case) to overwrite.
- `value` — the new value (any JSON type valid for that column).
- `reason` / `createdBy` — required, free text — corrections are edits to the
  record of truth and should always explain themselves.
- `active` — optional, defaults to `true`. Set to `false` to keep a
  correction on file (with its history) without applying it.

## Behavior

- **Idempotent**: `loadSeedCorrections` upserts by
  `(targetTable, targetKey, field)` — re-running it with the same files
  updates rows in place rather than duplicating them.
- **Season-scoped vs global**: if `targetKey` includes a `season` field, the
  correction only applies while normalizing that season. A correction with
  no `season` key (e.g. one targeting a `players` row) applies every time —
  harmless, since setting the same field to the same value repeatedly is a
  no-op in effect.
- **Never crashes the rebuild**: an unknown table, an unknown column, or a
  `targetKey` that matches no row is logged as a warning and skipped, not
  thrown. A bad correction should never take down an entire season's
  normalize run.

See `corrections.example.json` in this directory for a fuller worked
example, and `src/server/sync/corrections.ts` for the implementation.
