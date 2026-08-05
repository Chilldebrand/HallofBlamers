# Hall of Blamers engineering guide

## Architecture boundaries

- Preserve the data flow: ESPN snapshots -> normalized data -> transactionally rebuilt derived stats.
- Keep `src/engines` pure: no database, network, or framework side effects.
- Server code alone reads the database. The worker alone writes to ESPN and performs synchronization.
- Keep pages dynamically server-rendered; do not introduce static output that bypasses current data.
- Event and achievement keys must be deterministic, so rebuilds remain idempotent.
- Model historical and aggregate statistics around franchises, not manager identities.

## Required checks and operations

```bash
npm test
npm run build
npm run db:migrate
npm run backfill -- --from <year> --to <year> --league 1690915927
npm run stats:build
```

Use `npm run audit:identity` before committing rebrand-sensitive changes. Never commit `.env`, `data/`, live seed files, or SQLite artifacts.
