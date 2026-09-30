# Migration checkpoint — September 29, 2026

Implementation is underway. The website has not been deployed, and the static client is not a finished replacement for the existing app.

## Verified locally

- Created a consistent SQLite backup under ignored `data/migration-2026-09-29/`; SQLite quick_check returned `ok`. The original database was opened read-only.
- Imported all 51 application tables into local Postgres (PGlite) without rejecting a row. Compared every imported row/value after timestamp, boolean, and JSON conversion: no mismatches.
- Local Postgres database size: 86,687,867 bytes, including local system overhead. This is not a measurement of hosted Supabase usage.
- Migration tests cover missing source files, WAL reads, safe identifier quoting, repeat imports, foreign-key rollback, dry runs, populated-target refusal, content-drift detection, and initial private table access.
- Auth SQL tests use actual Postgres roles to check anonymous/uninvited denial, one-use invitation redemption, expiry, revocation with a valid session, and commissioner restrictions. Supabase's hosted JWT/REST behavior still needs testing.
- Hash-route tests cover repository-path deep links, query parameters, malformed routes, and external redirect rejection.
- Full suite: 113 files, 1,359 tests passed. Both TypeScript configurations pass. Existing Next production build and the new Vite Pages build pass.
- The five pre-existing source-name audit findings were corrected. The existing fonts are bundled locally instead of fetched during builds; font families and design tokens are preserved.

## Current implementation boundaries

Postgres schema/import/reconciliation and membership RPCs are implemented. The static client currently has sign-in/session infrastructure and route parsing only. League page adapters, invitation redemption UI, interactive actions, the cloud sync worker, hosted import, Pages deployment, and full visual/production checks remain unfinished. Do not publish the current static client as the completed website.

No cloud data was uploaded, no migrations applied to Supabase, no DWS resources changed, and no paid plan selected during this checkpoint.

## Required user action

The Supabase new-project form is prepared for `HallofBlamers` in the existing Free organization, with automatic table exposure off and automatic RLS on. The user must enter/save the new database password and submit project creation in the browser. Do not request that password in chat. Hosted configuration and verification follow after the project exists.

## Resume

Use the existing worktree and approved implementation plan. Read this checkpoint plus `.superpowers/sdd/2026-09-29-github-pages-supabase/progress.md`; do not rerun the completed full import unless its code/schema changes. Continue the unfinished boundaries above. Preserve the existing uncommitted AGENTS.md edit, original SQLite database, backup, and local Postgres test database.

## September 30 continuation

- Verified the user-created HallofBlamers Supabase project is healthy in the Free organization. Project ref: aridozcvdxlfnibcnejf. Public frontend connection configured locally.
- Added a transactional migration runner with checksum history, rollback, and a project-locked hosted CLI. Two migration-runner tests pass.
- Added authenticated shell and standings RPCs with explicit column allowlists. Anonymous and revoked callers are denied in Postgres integration tests.
- Ported standings calculations and the existing responsive standings presentation into the Pages client; shared pure helpers preserve the existing Next implementation. Added authenticated navigation, loading/error states, sign-out, and periodic reads.
- Current verification: 117 test files / 1,367 tests pass; both TypeScript configurations pass; targeted ESLint passes; Pages build passes. The original Next production build passed at the previous checkpoint, before this continuation.
- The static client is still an incomplete preview: standings is the only ported league page. Other pages, invitations, mutations, worker, hosted validation, and deployment remain unfinished.
- Supabase migrations/data have NOT been applied remotely. The ignored .env.supabase.local file still has an empty PGPASSWORD. User must save the database password there; do not send it in chat. This replaces the older project-creation handoff above.
