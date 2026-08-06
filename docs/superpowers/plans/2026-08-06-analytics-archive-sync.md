# Analytics and Archive Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transplant the league-neutral historical analytics and archive feature waves from BB_Football upstream `12c8876` into Hall of Blamers, backed only by the local private ESPN archive.

**Architecture:** Build the retained-data pipeline first, then deterministic analytics engines, server queries, protected commissioner tools, and read-only league pages. The schema/migrations from the foundation are already present; all new features read Hall of Blamers snapshots and normalized data, and integrations remain disabled. Every upstream copy conflict defaults to the existing Hall of Blamers identity, invite authorization, commissioner flow, and local seed/data overlays.

**Tech Stack:** Next.js 16 App Router, TypeScript, Vitest, Drizzle ORM, SQLite, existing ESPN normalizer/stat builder.

## Global Constraints

- Source reference is `C:\Users\hilde\AppData\Local\Temp\hallofblamers-bb-football-reference`; compare `d72bbb0..12c8876` and copy only the paths named by each task.
- Preserve Hall of Blamers name, HOB icons, private ESPN league `1690915927`, local database, stored ESPN cookies, seeds, corrections, invitations, and uncommitted `AGENTS.md`.
- Never copy source seeds, snapshot/database files, credentials, source repository metadata, source copy, domains, manager names, generated articles, or source-league identity assets/copy.
- All analytics must treat absent historical data as an empty state; do not fabricate player, draft, trade, or transaction history.
- Admin mutations use the existing commissioner guard and audit their own typed validation; public routes are read-only.
- Standalone TypeScript commands retain `tsx --env-file-if-exists=.env`.

---

### Task 1: Recover transactions and add waiver/trade analytics

**Files:**

- Create: `src/engines/rosterPossession.ts`, `src/engines/waiverROI.ts`, `src/engines/tradeRosterDiff.ts`, `src/engines/tradeAnalytics.ts`
- Create: corresponding `src/engines/__tests__/rosterPossession.test.ts`, `waiverROI.test.ts`, `tradeRosterDiff.test.ts`, `tradeAnalytics.test.ts`
- Create: `src/server/queries/transactions.ts`, `src/server/queries/__tests__/transactions.test.ts`
- Create: `src/app/(league)/transactions/page.tsx`, `src/app/(league)/transactions/columns.tsx`
- Modify: `src/server/sync/normalize.ts`, `src/server/sync/espn-shapes.ts`, `src/server/sync/run-tier.ts`, their focused tests, `src/engines/index.ts`, and `src/server/queries/home.ts` only where the upstream delta adds transaction facts.

**Interfaces:**

- Produces `buildRosterPossession`, `computeWaiverRoi`, `diffTradeRosters`, and `analyzeTrade` pure engine exports accepting normalized transaction/roster records and returning deterministic, empty-safe results.
- Produces `getTransactionCenter` query data for a public `/transactions` page; no page or query accepts raw ESPN cookie material.
- Preserves the upstream `transaction_items.source` discriminator and uses it only to distinguish recovered league-wide records from existing archive records.

- [ ] **Step 1: Add the engine and query tests before implementation.**

  Add literal fixtures for: one claimed player who later scores, one two-team trade with before/after rosters, an empty transaction list, and a recovered multi-team transaction. Assert the explicit waiver value/ROI, retained roster delta, and stable empty outputs. Add a query test asserting that an unauthenticated page model contains no commissioner-only fields.

- [ ] **Step 2: Run the focused tests and observe missing-module failures.**

  Run: `npm.cmd test -- src/engines/__tests__/rosterPossession.test.ts src/engines/__tests__/waiverROI.test.ts src/engines/__tests__/tradeRosterDiff.test.ts src/engines/__tests__/tradeAnalytics.test.ts src/server/queries/__tests__/transactions.test.ts`

  Expected: FAIL because the new engine/query modules are absent.

- [ ] **Step 3: Copy the exact league-neutral upstream implementation and adapt the normalizer boundary.**

  Use `git diff d72bbb0..12c8876 --` over only the files listed above. Keep existing Hall of Blamers ESPN shapes/identity values. Normalize a transaction only when ESPN supplied it; preserve source and participant franchise IDs rather than inferred display names.

- [ ] **Step 4: Implement the public Transaction Center.**

  Render the server query’s loading/empty/data states. Use existing `FranchiseName` display helpers, but never bring upstream franchise labels, logos, or colors. Give incomplete recovered trades a clear data-quality disclosure rather than an invented verdict.

- [ ] **Step 5: Verify and commit.**

  Run the focused suite, `npm.cmd run typecheck`, and `npm.cmd run lint`; then commit only listed source/tests with `feat: add historical transaction analytics`.

### Task 2: Add deterministic scenario and playoff analytics

**Files:**

- Create: `src/engines/whatIf.ts`, `eloCalibration.ts`, `playoffOdds.ts`, `playoffOddsBacktest.ts`
- Create: their focused engine tests including `whatIf.test.ts`, `eloCalibration.test.ts`, `playoffOdds.test.ts`, and `playoffOddsBacktest.test.ts`
- Create: `src/server/queries/whatIf.ts`, `playoffOdds.ts` and their tests
- Create: `src/app/(league)/what-if/page.tsx`
- Modify: `src/engines/index.ts`, `src/server/stats/build.ts`, `src/server/stats/playoffOddsBacktest-cli.ts`, `src/server/stats/__tests__/playoffOdds-build.test.ts`, `src/server/queries/home.ts`, and `package.json` only when the upstream delta requires an already-declared script.

**Interfaces:**

- `runWhatIfScenario` returns a schedule-swap/perfect-lineup comparison from supplied completed matchup data; it never mutates stored results.
- `calculatePlayoffOdds` returns seeded/reproducible probabilities and an explicit unavailable result when a season lacks enough schedule information.
- `getPlayoffOdds` and `getWhatIfPageData` are read-only server query models for Hall of Blamers historical seasons.

- [ ] **Step 1: Write failing pure-engine tests.**

  Add literal four-team schedule fixtures proving a schedule swap changes only its affected wins, a perfect-lineup scenario cannot lower a team score, and identical probability inputs/seed return the same table. Add an insufficient-data test expecting a typed unavailable result, not fabricated percentages.

- [ ] **Step 2: Run focused tests and confirm missing exports fail.**

  Run: `npm.cmd test -- src/engines/__tests__/whatIf.test.ts src/engines/__tests__/eloCalibration.test.ts src/engines/__tests__/playoffOdds.test.ts src/engines/__tests__/playoffOddsBacktest.test.ts`

- [ ] **Step 3: Implement the upstream pure engines and persisted build integration.**

  Apply only the upstream diff named above. Keep the upstream simulation seed/calibration behavior, but leave absent Hall of Blamers inputs unavailable. Store derived playoff records through the existing stat-build transaction, never directly from a route.

- [ ] **Step 4: Add query and page behavior.**

  Render season selection, clear unavailable-state copy, and scenario controls that only submit validated server-side parameters. Do not add a live external feed or any client-side secret.

- [ ] **Step 5: Verify and commit.**

  Run focused engine/query tests, `npm.cmd run stats:build`, `npm.cmd run typecheck`, and `npm.cmd run lint`; commit as `feat: add scenario and playoff analytics`.

### Task 3: Build archive analytics for draft, revenge, hall, tendencies, and achievements

**Files:**

- Create: `src/engines/draftValue.ts`, `draftGrades.ts`, `draftRosterConstruction.ts`, `revengeTracking.ts`, `hallOfFame.ts`, `managerTendencies.ts`
- Create: each matching focused engine test
- Create: `src/server/queries/draft.ts`, `revenge.ts`, `hallOfFame.ts`, `tendencies.ts` and matching tests
- Create: `src/app/(league)/draft/page.tsx`, `src/app/(league)/revenge/page.tsx`, `revenge/columns.tsx`, `src/app/(league)/hall/page.tsx`
- Modify: `src/engines/achievements.ts`, `src/engines/context.ts`, their tests, `src/server/queries/achievements.ts`, `src/app/(league)/franchises/[id]/page.tsx`, and `src/components/history/AchievementTrophyCase.tsx` only for upstream generic archive features.

**Interfaces:**

- Engines accept only normalized Hall of Blamers archive rows and return season-scoped/career-scoped data with an explicit empty result when source records do not exist.
- Archive queries return canonical franchise IDs plus values; all display naming remains in Hall of Blamers presentation components.
- `/draft`, `/revenge`, and `/hall` are public, read-only pages. The franchise profile adds tendencies only when history supports them.

- [ ] **Step 1: Add tests before implementations.**

  Use literal season fixtures to assert draft reach/steal ordering, revenge closes at a redraft boundary, Hall of Fame/ Shame ties sort deterministically, and tendency denominators exclude incomplete seasons. Extend achievements tests for one added badge and its season eligibility.

- [ ] **Step 2: Run the new engine tests and confirm expected missing-export failures.**

  Run: `npm.cmd test -- src/engines/__tests__/draftValue.test.ts src/engines/__tests__/revengeTracking.test.ts src/engines/__tests__/hallOfFame.test.ts src/engines/__tests__/managerTendencies.test.ts src/engines/__tests__/achievements.test.ts`

- [ ] **Step 3: Apply the exact upstream archive-engine/query delta.**

  Copy only the listed file families. Preserve existing achievement records and Hall of Blamers terminology. Do not import generated source stories, real player claims, source-era rankings, or source manager names.

- [ ] **Step 4: Render public archive pages.**

  Follow existing page layout and empty-state patterns. Render every franchise through existing identity helpers and describe data absence plainly. Keep route copy Hall of Blamers-specific where a league name is shown.

- [ ] **Step 5: Verify and commit.**

  Run the listed engines/queries/page tests, `npm.cmd run stats:build`, typecheck, lint, and commit as `feat: add archive analytics pages`.

### Task 4: Add commissioner corrections and safe data export

**Files:**

- Create: `src/features/corrections/{CorrectionForm,actions,constants,queries,validation}.ts*` and their tests
- Create: `src/features/export/{queries}.ts` and tests
- Create: `src/app/(league)/admin/corrections/page.tsx`, `admin/corrections/[id]/page.tsx`, `admin/export/page.tsx`, `src/app/api/export/[dataset]/route.ts`, and its route test
- Modify: `src/features/admin/actions.ts`, `validation.ts`, `src/server/sync/corrections.ts`, its tests, `src/app/(league)/admin/page.tsx`, and `src/proxy.ts` only where upstream protects the new routes.

**Interfaces:**

- Commissioner-only actions validate a typed correction request, write through existing correction records, and then invoke the existing rebuild path.
- `GET /api/export/[dataset]` exports only allowlisted derived datasets; it must reject unknown datasets and non-commissioners without returning database paths, cookies, sessions, raw snapshots, or tokens.

- [ ] **Step 1: Add failing auth/validation/export tests.**

  Cover a valid commissioner correction, a malformed correction, a non-commissioner mutation attempt, an allowed derived export, an unknown dataset, and a request with no invite session. Each assertion checks the returned response/action state, not a mock call.

- [ ] **Step 2: Run focused tests and observe failure before implementation.**

  Run: `npm.cmd test -- src/features/corrections/__tests__/actions.test.ts src/features/corrections/__tests__/validation.test.ts src/features/export/__tests__/queries.test.ts src/features/export/__tests__/security.test.ts src/app/api/export/[dataset]/__tests__/route.test.ts`

- [ ] **Step 3: Apply the upstream commissioner tooling with the existing invite guard.**

  Use the named upstream diff, retaining `requireCommissioner`/invite authorization as the sole authorization boundary. Exclude every source config/credential and keep the export allowlist limited to sanitized league tables.

- [ ] **Step 4: Add the protected admin routes and verify unauthenticated behavior.**

  Pages must redirect/deny by the existing guard. Export routes set a safe attachment content type/name and contain only explicitly selected columns.

- [ ] **Step 5: Verify and commit.**

  Run focused tests, typecheck, lint, and commit as `feat: add commissioner archive tools`.

### Task 5: Integrate analytics into existing archive navigation and certify the wave

**Files:**

- Modify: `src/app/(league)/layout.tsx`, `src/components/layout/nav-items.ts`, `src/components/layout/TopNav.tsx`, `src/components/layout/BottomTabBar.tsx`
- Modify: `src/app/(league)/history/page.tsx`, `seasons/page.tsx`, `seasons/[year]/page.tsx`, `franchises/page.tsx`, `franchises/[id]/page.tsx`, `src/components/home/{LeadColumn,PlayoffRaceCard}.tsx`, and only directly required tests
- Modify: `scripts/verify-identity.mjs` and its test if it needs an explicit standalone `WBB` rejection.

**Interfaces:**

- Navigation exposes Analytics/Archive routes without removing existing Hall of Blamers routes.
- Every new franchise display uses canonical local franchise IDs and existing HOB identity helpers.
- Identity audit rejects standalone legacy `WBB` markers outside historical planning documents.

- [ ] **Step 1: Add failing navigation and identity tests.**

  Assert all new routes are in the intended public navigation groups, commissioner-only links remain hidden from public navigation, and a temporary standalone `WBB` marker makes the audit fail.

- [ ] **Step 2: Run tests and observe the absent nav/audit behavior.**

  Run: `npm.cmd test -- src/components/layout/nav-items.test.ts src/components/layout/TopNav.test.tsx src/components/layout/BottomTabBar.test.tsx` and the identity audit test.

- [ ] **Step 3: Integrate the routes and audit rule.**

  Preserve HOB labels, HOB icon assets, existing mobile/desktop accessibility behavior, and the invite-gated admin boundary. Do not copy source navigation copy, URLs, or external operations.

- [ ] **Step 4: Rebuild local derived stats and smoke test history.**

  Run `npm.cmd run stats:build`; verify the six imported seasons remain present, transaction/archive pages render empty-safe data, and `/admin` remains protected.

- [ ] **Step 5: Run whole-wave verification and commit.**

  Run `npm.cmd test`, `npm.cmd run typecheck`, `npm.cmd run lint`, `npm.cmd run audit:identity`, `npm.cmd run db:migrate`, and browser HTTP smoke checks. Commit as `feat: integrate analytics and archive navigation`.

## Self-review

- Scope is split by data dependency: transaction recovery, simulation, archive analytics, protected administration, then route integration.
- No task imports source identity, credentials, data, raw archives, or operations; explicit empty/unknown handling prevents invented local history.
- All user-facing archive features are read-only except commissioner-guarded corrections and a sanitized export allowlist.
- Tests cover deterministic results, no-data behavior, authorization, identity, and the complete wave.
