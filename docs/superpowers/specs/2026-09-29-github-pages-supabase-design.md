# Hall of Blamers: GitHub Pages and Supabase migration

Status: proposed for written-spec review. No hosted resources or application changes made.

## Agreed outcome

Host Hall of Blamers on GitHub Pages with its own appearance, branding, league data, and users. Use a dedicated Supabase Free project if measured usage fits. DWS Knockout is an infrastructure reference, not a visual template or shared database. No paid upgrade is authorized.

## Existing application

The working application is in `.worktrees/hall-of-blamers-transplant`, branch `codex/hall-of-blamers-transplant`, currently at `8452f04`. The main checkout is not the completed application. There is a pre-existing uncommitted AGENTS.md change that must be preserved.

The application uses Next.js server rendering, cookie-based invite authentication, synchronous SQLite/Drizzle queries, server actions, and a persistent Node worker. The current SQLite file is 210,464,768 bytes. Existing routes include standings, seasons, franchises, matchups, history, transactions, records, head-to-head, belt, what-if, pickem, polls, predictions, recaps, and commissioner administration. A route's presence does not certify that unfinished upstream features are complete.

## Selected approach and alternatives

Use a static React frontend on GitHub Pages, Supabase Postgres and Auth, database policies/RPCs for access, short Edge Functions for privileged requests, and GitHub Actions for heavy ESPN ingestion and analytics. Preserve reusable React components, styling, and pure calculation engines. Convert Next-specific rendering and routing to a Vite/React client application with hash routing, so every deep link works on Pages without server rewrites. Support the `/HallofBlamers/` base path.

Alternatives considered: retaining Next.js on a server would reduce migration work but does not meet the selected Pages hosting goal. Exporting private league data into static HTML would simplify hosting but break live data and private access requirements. Neither is selected.

The existing AGENTS.md server-rendering and server-only database rules must be intentionally updated during implementation to describe this architecture. Preserve their underlying requirements: fresh data, private access, deterministic stats, pure engines, and a sole ingestion writer.

## Data and authorization

Migrate normalized league data and derived statistics into Postgres, retaining identifiers and franchise relationships. Translate SQLite-specific SQL, synchronous calls, dates, boolean fields, constraints, and transactions deliberately. Validate counts and representative aggregates against the original database before cutover. Preserve the original database and make a verified backup before any migration operation.

Use Supabase Auth identities mapped to existing managers and commissioner roles. Keep membership invite-only; self-registration cannot grant league access. New invitations replace old server-cookie sessions. Existing manager and franchise history remains intact. Implement invitation redemption and revocation with server-side checks and expiring, single-use tokens. No invitation emails are sent without user authorization.

Apply row-level security before exposing tables. Anonymous visitors can retrieve the public app shell but no private league rows. Members can read permitted league data and change only their own eligible picks/votes/predictions. Enforce deadlines, membership, commissioner privileges, and ownership in the backend, not just the UI. Keep raw ESPN snapshots and administrative secrets out of browser-accessible schemas.

Only the Supabase URL and publishable key belong in frontend configuration. ESPN cookies, database passwords, service credentials, and optional AI credentials belong in backend secrets. Never embed them in Pages artifacts, logs, Git commits, or public build output.

## Sync and freshness

Replace the persistent worker with bounded, resumable Node jobs using existing pure engines. Use a database lease to prevent concurrent ingestion and publish each derived-stat generation atomically. Retry safely and retain the last successful generation on failure. Historical backfill and expensive analytics run in Actions rather than Edge Functions, whose CPU limits make full rebuilds unsuitable.

Proposed launch cadence: game-window refreshes every 15 minutes, hourly current-period sync otherwise, and daily correction checks. Actions scheduling is best effort. This explicitly changes the existing two-minute live-worker behavior. Display the last successful sync and stale/error states; do not claim real-time updates. A commissioner refresh request is authorized server-side and queued for the next worker run, with visible pending/running/failed states. Faster refreshes are a later measured improvement, not a launch promise.

Browser data queries refresh on navigation and periodically while visible. Replace server-sent live events with authenticated polling initially. Keep privacy controls on every read and write.

## Free-plan fit

Supabase Free currently includes a 500 MB database per project, 5 GB egress, 1 GB file storage, and up to two active free projects. The observed organization is DaleDanTony on Free; its displayed DWS usage was 28 MB database and 0.01 GB egress. Account-wide availability of the second project slot still needs final confirmation.

The 210 MB SQLite size does not establish Postgres size. Measure imported tables and indexes before enabling recurring ingestion, target at most 350 MB initially, and report actual usage. Profile snapshots separately; if retaining all history exceeds the budget, propose private archival/retention before omitting or deleting anything. Static visual assets stay on Pages. Do not enable optional paid AI/audio integrations as part of this migration.

Free projects may pause after a week of inactivity and lack included automatic backups. Provide a documented private backup/restore procedure. Measure Actions runtime against the account's included allowance; do not enable paid overages. If measured usage cannot fit, report the exact blocker instead of upgrading or dropping data silently.

## Delivery sequence

1. Inventory routes, server actions, queries, schema, and existing feature coverage; capture representative visual and data baselines.
2. Prepare Postgres migrations, access policies, invitation/auth flows, and a repeatable import into an isolated database.
3. Port the existing UI and route/data access layer, retaining its visual identity and feature coverage.
4. Adapt and verify ingestion/analytics jobs, freshness states, and private backup procedures.
5. Provision the dedicated free project, install reviewed migrations and secrets, then import and reconcile data.
6. Build and deploy Pages through the repository workflow; verify production login, deep links, access policies, and commissioner operations.

Provisioning requires the user to enter the new database password through the browser when prompted. Avoid changing DWS resources. Preserve the current local application as the rollback reference until hosted verification succeeds.

## Acceptance checks

- Characterize and preserve current working routes; explicitly report pre-existing unfinished features.
- Verify anonymous, member, revoked member, and commissioner permissions with direct API tests.
- Verify representative historic standings, matchups, transaction records, and analytics match the source database.
- Demonstrate idempotent imports and syncs, concurrent-run protection, and atomic publication on failure.
- Run relevant tests, type checks, production build, and identity audit; visually compare desktop and mobile against the existing app.
- Scan the built frontend for credentials and private embedded data; test Pages deep links and asset paths.
- Report actual database size, query/egress behavior, and workflow runtime before asserting free-tier suitability.
- Finish with the live site URL and verified status, or a precise external blocker. A frontend deployment alone is not completion.

## References checked

- https://supabase.com/pricing
- https://supabase.com/docs/guides/platform/billing-faq
- https://supabase.com/docs/guides/platform/free-project-pausing
- https://supabase.com/docs/guides/functions/limits
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax

## Review checklist

Intent and independent identity preserved; no paid services assumed; existing data and edits protected; privacy enforced server-side; two-minute refresh change explicit; import size remains a measured launch gate; rollback and end-to-end acceptance included.
