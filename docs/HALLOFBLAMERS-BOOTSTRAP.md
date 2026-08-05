# Hall of Blamers private bootstrap

Run these commands from the repository root to bootstrap a local Hall of Blamers installation:

```bash
cp .env.example .env
npm run db:migrate
npm run backfill -- --from 2021 --to 2026 --league 1690915927
npm run seed:suggest > seed/franchises.json
# Review ownership, renamed teams, and manager handoffs.
npm run normalize
npm run stats:build
cp seed/managers.example.json seed/managers.json
# Replace synthetic local manager rows, then:
npm run seed:managers
```

`seed:suggest` groups ESPN owner SWIDs, but a human must approve canonical franchises and ownership
windows before normalization. Missing mappings are intentionally hard validation failures: resolve
each team-season mapping rather than allowing the normalizer to infer franchise history.

`.env`, real seed files, corrections, database files, raw snapshots, and invite links never enter
Git. Only the synthetic `*.example.json` templates are versioned; copy them locally and replace
their placeholder rows with the approved private league data.
