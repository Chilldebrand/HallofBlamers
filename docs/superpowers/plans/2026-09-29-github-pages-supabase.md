# GitHub Pages and Supabase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended here) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the existing Hall of Blamers experience to GitHub Pages with a private, dedicated free Supabase backend.

**Architecture:** Preserve the local Next/SQLite application as a reference while building a Vite React client alongside it. Move authoritative data and access rules to Postgres, short privileged operations to Edge Functions, and heavy ingestion/calculation to bounded Node jobs in GitHub Actions. Cut over only after data, access, feature, and visual checks pass.

**Tech Stack:** Existing React, TypeScript, Tailwind, Vitest, and pure engines; Vite, React Router hash routing, Supabase JS/Auth/Postgres, Postgres Node driver, GitHub Actions/Pages.

**Spec:** `docs/superpowers/specs/2026-09-29-github-pages-supabase-design.md` (approved in chat).

## Global Constraints

- Work in the existing `codex/hall-of-blamers-transplant` worktree. Preserve the user's existing AGENTS.md edit.
- Hall of Blamers keeps its own appearance, branding, league data, and users. Do not modify DWS resources.
- No paid upgrade is authorized. Do not enable paid overages or optional paid AI/audio integrations.
- Support the `/HallofBlamers/` base path and hash deep links.
- Proposed launch cadence: game-window refreshes every 15 minutes, hourly current-period sync otherwise, and daily correction checks.
- Target at most 350 MB initially within Supabase's 500 MB free database allowance; measure rather than infer from SQLite.
- Preserve original data, deterministic identities, franchise history, pure engines, and atomic derived-stat publication.
- Never commit `.env`, `data/`, live seed files, SQLite files, database exports, or secrets. Public build output must contain no private league rows.
- Authentication and authorization apply at the backend. A hidden UI button is not an access control.
- New database password entry requires user browser handoff. Invitation emails require explicit user authorization.

## Review Focus

1. A revoked or uninvited authenticated user must lose database access even with a cached frontend session (Task 3).
2. Reloading a match detail link under the repository path must preserve route parameters and load assets (Task 4).
3. ESPN stat corrections or a crashed rebuild must never expose a mixture of old and new aggregates (Task 6).
4. Double-clicked votes/picks, replayed invitations, and writes at the deadline must have deterministic server-enforced outcomes (Task 5).
5. An off-season, unavailable historical dataset, or failed sync must show truthful empty/stale states without invented results (Tasks 4 and 6).

## File and Interface Map

- `web/`: standalone client entry, routes, session provider, typed data access, and page adapters. Reuse `src/components`, presentation parts of `src/features`, and the current CSS/assets; do not copy DWS layouts.
- `supabase/migrations/`: ordered SQL for private ingestion tables, league tables, constraints, RLS, read RPCs, mutations, and worker coordination.
- `supabase/functions/league-admin/`: short authenticated invitation and refresh-request operations.
- `migration/`: read-only SQLite inspection/import/reconciliation and private backup tools.
- `worker/cloud/`: asynchronous Postgres repository, ingestion jobs, and atomic stats publication, using `src/engines` without framework dependencies.
- `.github/workflows/pages.yml` and `league-sync.yml`: deployment and bounded scheduled/manual jobs.
- `docs/migration/`: route inventory, measured baseline, rollout/rollback instructions, and final verification record, containing no secrets or raw private rows.

Core interfaces (define once, share through `src/contracts/cloud.ts`):

```ts
type SyncTier = 'live' | 'hourly' | 'daily';
type Viewer = { authUserId: string; managerId: number; role: 'member' | 'commissioner' };
type SyncStatus = { state: 'idle' | 'pending' | 'running' | 'failed'; lastSuccessAt: string | null; generationId: string | null };
type PageRequest = { route: string; params: Record<string, string>; query: Record<string, string> };
type PageEnvelope<T> = { data: T; sync: SyncStatus };
```

Read contracts for each route retain the existing query result's fields, dates serialized to ISO strings, big integer IDs within JavaScript's safe integer range or serialized as strings. Define named page DTOs during Task 1 rather than passing arbitrary SQL or generic table names from the browser.

## Task 1: Capture parity baseline and migration contracts

**Files:** Create `docs/migration/route-inventory.md`, `src/contracts/cloud.ts`, `migration/inspect-sqlite.ts`, `migration/__tests__/inspect-sqlite.test.ts`; read `src/app/**/page.tsx`, `src/server/queries/*.ts`, and `src/features/**/actions.ts`.

**Interfaces:** `inspectSqlite(path: string): Promise<{ bytes: number; tables: { name: string; rows: number }[] }>` opens read-only; `src/contracts/cloud.ts` defines named DTOs for inventoried pages and mutation inputs.

- [ ] Record each actual route, its query/actions, role requirements, and known working/unfinished state. Include admin recaps/polls, invitation/login, API health/live, and dynamic detail routes. Map each to a target hash route.
- [ ] Write `inspectSqlite_preserves_source` with assertions `expect(afterHash).toBe(beforeHash)` and `expect(report.tables.find(t => t.name === 'managers')?.rows).toBe(2)` against a tiny fixture. Verify the new test fails before implementation with `npx vitest run migration/__tests__/inspect-sqlite.test.ts`.
- [ ] Implement the read-only profiler; collect a baseline from a consistent backup using the existing backup API. Do not use a naive copy of an active WAL database.
- [ ] Run current `npm test`, `npm run typecheck`, `npm run build`, and `npm run audit:identity` once; record pre-existing failures separately. Capture representative desktop/mobile views if the local app runs. A missing historical design document is not a reason to invent a new design.
- [ ] Run the profiler test to PASS, document DTOs from actual consumers, and commit only new contracts/tools/documentation.

## Task 2: Postgres schema and repeatable import

**Files:** Create `supabase/config.toml`, `supabase/migrations/202609290001_schema.sql`, `migration/import-sqlite.ts`, `migration/reconcile.ts`, `migration/__tests__/import.test.ts`; modify `package.json` and lockfile for migration tools.

**Interfaces:** `importSqlite(sourcePath: string, targetUrl: string, options: { dryRun: boolean }): Promise<ImportReport>`; `reconcile(sourcePath: string, targetUrl: string): Promise<{ passed: boolean; mismatches: string[]; databaseBytes: number }>`; `ImportReport` contains table counts, rejected rows, and elapsed time, never credentials or raw rows.

- [ ] Write `repeat_import_preserves_ids_and_counts`, `invalid_foreign_key_rolls_back`, and `reconcile_detects_aggregate_drift`; assert repeat counts equal initial counts, rejected transactions leave zero partial rows, and changed source scores produce a failed reconciliation. Run `npx vitest run migration/__tests__/import.test.ts` against an isolated Postgres test database and observe initial failure.
- [ ] Translate every actual SQLite table and constraint, including newer analytics tables. Keep snapshots in a non-exposed private schema; create protected manager-to-Auth mapping separately. Enable RLS and revoke public access in the same migration.
- [ ] Implement ordered, transactional, resumable imports with safe sequence advancement and explicit date/JSON/boolean conversions. Refuse an unmarked nonempty target to prevent accidental imports into DWS.
- [ ] Compare table counts, season scores, wins/losses, franchise mappings, transactions, and representative derived statistics. Profile table/index size. If projected size exceeds 350 MB, report snapshot/archive options before changing retention.
- [ ] Run import tests to PASS; record local Postgres results, or explicitly report unavailable test infrastructure. Commit schema/import tools. Do not claim hosted size validation yet.

## Task 3: Membership, invitations, and backend access policies

**Files:** Create `supabase/migrations/202609290002_auth.sql`, `supabase/functions/league-admin/index.ts`, `web/src/auth/session.tsx`, `web/src/lib/supabase.ts`, `supabase/tests/auth.integration.test.ts`.

**Interfaces:** `getViewer(): Promise<Viewer | null>`; Edge Function operations `create-invite`, `redeem-invite`, `revoke-member`, and `request-sync`, using verified Supabase JWTs. Invite redemption accepts `{ token: string }`, binds the current Auth user to the invited manager once, and returns `Viewer`.

- [ ] Write integration assertions for anonymous denial, invited membership, uninvited Auth-user denial, commissioner-only invite creation, token expiry/replay denial, and immediate revoked-member denial. Run `npx vitest run supabase/tests/auth.integration.test.ts` and observe policy failures before implementation.
- [ ] Implement invite-only mapping and Supabase Auth session handling. Store invite hashes rather than plaintext tokens; authorize all admin operations server-side. Preserve manager IDs and commissioner identity, but invalidate legacy server-cookie sessions at cutover.
- [ ] Add RLS and explicit grants for league reads, private snapshot denial, and manager-owned writes. Use restricted search paths for security-definer functions and revoke unnecessary execution privileges.
- [ ] Implement sign-in/out, session-expired and revoked states, and membership revalidation. Do not send email or grant external integrations during testing.
- [ ] Run auth integration tests to PASS with anonymous/member/commissioner/revoked JWTs; commit auth and policies.

## Task 4: Static client and all read-only page adapters

**Files:** Create `web/index.html`, `web/vite.config.ts`, `web/tsconfig.json`, `web/src/main.tsx`, `web/src/router.tsx`, `web/src/api/read.ts`, `web/src/pages/`, `web/tests/routes.test.tsx`, `supabase/migrations/202609290003_reads.sql`; modify `package.json`, lockfile, and presentation components requiring Next-specific adapters.

**Interfaces:** `loadPage<T>(request: PageRequest, signal?: AbortSignal): Promise<PageEnvelope<T>>`, implemented through an explicit route-to-RPC map matching Task 1's DTOs; no browser-supplied SQL. `useViewer()` consumes Task 3's session provider.

- [ ] Write `deep_link_survives_reload` asserting `/#/matchups/2026/1/1` under `/HallofBlamers/` yields the correct route params; `anonymous_shell_contains_no_league_rows`; and `unavailable_history_is_explicit` asserting an unavailable state instead of synthetic scores. Run `npx vitest run web/tests/routes.test.tsx` and observe failures.
- [ ] Set up Vite with the repository base path, hash routing, existing Tailwind styles, and local font/assets. Retain the old Next entry while the client is incomplete; add `dev:pages`, `build:pages`, and `typecheck:pages` scripts.
- [ ] Convert each inventoried read page in cohesive groups: home/standings/seasons/matchups/franchises; history/records/h2h/belt/timeline; transactions/what-if/analytics; recaps/polls/predictions/pickem/admin read views. Preserve the existing appearance and meaningful empty states.
- [ ] Implement authenticated read RPCs and pagination. Fetch current data after sign-in and on navigation; poll while visible and retain last good data on transient errors. Show sync timestamp/status consistently.
- [ ] Run route tests, `npm run typecheck:pages`, and `npm run build:pages` to PASS; inspect desktop/mobile parity and every route in the inventory before committing the complete read-client stage.

## Task 5: Interactive league and commissioner actions

**Files:** Create `supabase/migrations/202609290004_mutations.sql`, `web/src/api/mutations.ts`, `supabase/tests/mutations.integration.test.ts`; adapt UI callers of `src/features/{admin,pickem,polls,predictions,recaps}/*actions.ts` using browser-safe modules.

**Interfaces:** Export typed mutation functions matching Task 1's action inventory, each returning `{ ok: true } | { ok: false; code: string; message: string }`. Mutations execute named RPCs or Task 3's authenticated Edge endpoint; no service key in client code.

- [ ] Write tests asserting another manager's pick is denied, a write at/after lock time fails, duplicate submission is idempotent, poll rules hold under concurrency, and non-commissioner recap/admin changes fail. Run `npx vitest run supabase/tests/mutations.integration.test.ts` and observe failures.
- [ ] Port business validation from each inventoried server action to database transactions or short authenticated functions. Use server time for deadlines and unique constraints for duplicate protection.
- [ ] Wire client forms to these APIs, preserving loading/errors and input drafts. Provide commissioner invitation/revocation and refresh-request status. Preserve optional integration configuration without enabling paid providers.
- [ ] Verify success, validation, unauthorized, expired session, and network-failure behavior; rerun mutation tests, Pages typecheck/build, then commit.

## Task 6: Bounded cloud worker and truthful freshness

**Files:** Create `worker/cloud/repository.ts`, `worker/cloud/run.ts`, `worker/cloud/publish.ts`, `worker/cloud/__tests__/run.test.ts`, `supabase/migrations/202609290005_sync.sql`, `.github/workflows/league-sync.yml`; reuse pure engines and adapt persistence from `src/server/{espn,sync,stats}`.

**Interfaces:** `runCloudSync(tier: SyncTier): Promise<{ state: 'completed' | 'skipped'; generationId: string | null }>`; `publishGeneration(generationId: string): Promise<void>`; database lease acquisition/renewal/release and publication are service-only operations. `SyncStatus` is Task 1's shared type.

- [ ] Write tests asserting a second lease contender skips, a crash leaves the active generation unchanged, corrected scores replace all affected aggregates together, retries preserve deterministic event keys, expired ESPN credentials expose failure status without leaking secrets, and off-season live jobs skip. Run `npx vitest run worker/cloud/__tests__/run.test.ts` and observe failures.
- [ ] Implement asynchronous Postgres repositories and bounded ingestion preserving snapshots → normalized data → derived stats. Use staging generations and one transaction to publish; do not round-trip the full database for every live tick.
- [ ] Add service-only queued commissioner refreshes and resumable historical backfill commands. Retain existing local worker as rollback reference; hosted jobs must not depend on local SQLite.
- [ ] Configure 15-minute game-window schedules with America/New_York gating inside the job, hourly refresh and daily corrections, concurrency and timeout limits. Actions schedules remain best effort. Use a database lease across scheduled and manual entry points.
- [ ] Run worker tests to PASS; measure representative job runtime and API volume before enabling schedules. Run relevant existing analytics tests and commit worker/workflow changes.

## Task 7: Provision, migrate, verify budget, and deploy

**Files:** Create `.github/workflows/pages.yml`, `migration/backup-postgres.ts`, `scripts/verify-pages-artifact.mjs`, `docs/migration/operations.md`, `docs/migration/verification.md`; update `README.md`, `.env.example`, and architecture paragraphs in `AGENTS.md` without replacing pre-existing edits.

**Interfaces:** `backupPostgres(destination: string): Promise<{ path: string; bytes: number }>` writes only to an ignored private destination; `verify-pages-artifact.mjs` exits nonzero if secrets, private fixtures, or server-only imports are present in the build.

- [ ] Prepare the dedicated Free project in the existing account; verify the free-project slot and $0 plan. Hand password entry to the user. Do not alter DWS or upgrade billing. Complete any browser-required access confirmation only when the concrete action is ready.
- [ ] Apply reviewed schema/policies to the new project and configure required backend secrets through authorized secure paths. Import the consistent backup, run reconciliation, and record real Postgres database/index size. Stop cutover on any mismatch or budget failure.
- [ ] Verify hosted auth and action policies with test identities and private data. Confirm the commissioner mapping with the user if the existing record is ambiguous. No unsolicited invitation emails.
- [ ] Add the Pages workflow building only `web/dist`, with public configuration only and appropriate Pages deployment permissions. Run tests, both relevant typechecks/builds, and identity/secret audits before release.
- [ ] Make a private database backup and test restoration into an isolated target. Document off-season resume, secret rotation, failed sync recovery, retention, and rollback to the existing local app. Never place private backups in public Actions artifacts.
- [ ] Publish the approved changes through GitHub; inspect branch protection and use a PR if required. Attach any created PR to the chat. Enable scheduled ingestion only after measured runtime fits the included allowance.
- [ ] Verify the actual Pages URL, nested hash reloads, assets, member login, anonymous denial, commissioner operations, data reconciliation, and last-successful-sync timestamp. Record evidence and any pre-existing feature gaps. Report the live URL only after these checks pass.

## Execution and Review

Recommended execution: native implementation in this chat, with one independent whole-branch review at the end. Tasks are sequential because schema, authorization, page contracts, and worker publication depend on one another. Keep focused verification within each stage; avoid repeated feature-by-feature review loops.

No application changes or hosted resource creation are authorized by this document alone: the user reviews this plan and selects execution before implementation under the installed workflow. Once selected, proceed through the plan without repeatedly requesting permission for ordinary implementation choices.

## Self-review

The seven stages cover baseline/rollback, data migration, privacy/auth, the independent visual experience, every inventoried feature, scheduled jobs, free-tier measurement, backups, and production verification. Review-focus cases are assigned explicit tests. Heavy computation remains outside Edge Functions; both private data and secrets remain outside Pages builds. All provisional route DTOs are derived from actual consumers in Task 1 and then shared, avoiding incompatible later interfaces.
