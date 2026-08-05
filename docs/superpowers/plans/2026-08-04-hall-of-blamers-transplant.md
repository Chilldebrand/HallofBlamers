# Hall of Blamers Transplant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recreate BB_Football as a standalone, feature-complete Hall of Blamers ESPN fantasy-football hub without carrying over BB_Football data, secrets, branding, or Git history.

**Architecture:** Import source revision `d72bbb0b25887e91c4ad256de4957d330126726f` as files only, then rebrand before the first application commit. Retain the existing Next.js, SQLite, Drizzle, web/worker, snapshots → normalized → derived architecture. Hall of Blamers uses its own private ESPN configuration and a fresh database.

**Tech Stack:** Next.js 16, React 19, TypeScript 5 strict, Tailwind 4, SQLite/better-sqlite3, Drizzle, Vitest, Croner, Motion, Docker Compose, Cloudflare Tunnel.

## Global Constraints

- Import all source runtime code, migrations, tests, fixtures, routes, worker jobs, and Docker operations.
- Do not import source `.git`, `.claude`, `AGENTS.md`, `CLAUDE.md`, source roadmap, source design prototypes, `seed/franchises.json`, `seed/managers.json`, `seed/corrections/corrections.json`, `data`, `.env`, or any SQLite file.
- Hall of Blamers uses private ESPN league `1690915927` and a backfill from 2021 through 2026.
- Never commit `ESPN_S2`, `ESPN_SWID`, `SESSION_SECRET`, `ANTHROPIC_API_KEY`, Cloudflare credentials, snapshots, database artifacts, manager mappings, franchise mappings, corrections, or invite URLs.
- Preserve the current UI, responsive behavior, feature set, worker-only ESPN writes, and full-rebuild derived stats.
- Outside `docs/superpowers/`, no tracked file may contain `West Blue Bell`, `westbluebell.com`, `FFootball`, `ffootball`, `BB_Football`, or `richey1406-prog`.
- Use no hard-coded public hostname; operating docs refer to the configured public hostname.

## File Structure

**Imported unchanged:** root tooling, app routes, components, features, engines, server modules, worker, operations scripts, migrations, tests, and synthetic test fixtures.

**HallofBlamers adaptations:** `package.json`, `package-lock.json`, `.env.example`, `.gitignore`, `Dockerfile`, `docker-compose.yml`, `README.md`, `docs/RUNBOOK.md`, `ops/setup.sh`, `ops/deploy.sh`, `src/app/layout.tsx`, `src/app/manifest.json`, both SVG icons, `src/app/login/page.tsx`, `src/app/(league)/error.tsx`, `src/components/layout/TopNav.tsx`, source-identity comments, and source-identity tests.

**New files:** `AGENTS.md`, `scripts/verify-identity.mjs`, `docs/HALLOFBLAMERS-BOOTSTRAP.md`.

**Local-only files:** `.env`, `data/league.db`, `seed/franchises.json`, `seed/managers.json`, `seed/corrections/corrections.json`.

---

### Task 1: Import a source archive without source-league state

**Files:**

- Create all source runtime, test, and fixture files except the exclusions above.
- Preserve `docs/superpowers/specs/2026-08-04-hall-of-blamers-design.md` and this plan.
- Do not commit yet: source branding must be removed first.

**Interfaces:**

- Consumes the frozen source revision and HallofBlamers repository containing its specification commit.
- Produces the complete source code structure without source history, data, or credentials.

- [ ] **Step 1: Verify the source revision**

Run in the temporary source checkout:

~~~powershell
$source = 'C:\Users\hilde\AppData\Local\Temp\hallofblamers-bb-football-reference'
$revision = 'd72bbb0b25887e91c4ad256de4957d330126726f'
& 'C:\Program Files\Git\cmd\git.exe' -C $source rev-parse $revision
& 'C:\Program Files\Git\cmd\git.exe' -C $source diff --quiet $revision --
~~~

Expected: the commit resolves and no source working-tree changes exist.

- [ ] **Step 2: Create a source archive instead of copying its Git repository**

~~~powershell
$stage = 'C:\Users\hilde\AppData\Local\Temp\hallofblamers-source-stage'
New-Item -ItemType Directory -Force -Path $stage | Out-Null
& 'C:\Program Files\Git\cmd\git.exe' -C $source archive --format=zip --output "$stage\source.zip" $revision
Expand-Archive -LiteralPath "$stage\source.zip" -DestinationPath "$stage\tree" -Force
~~~

Expected: the staged tree includes files only and has no `.git` directory.

- [ ] **Step 3: Delete excluded source material from the disposable staging tree**

~~~powershell
$excluded = @(
  '.claude', 'AGENTS.md', 'CLAUDE.md',
  'docs\Fantasy Football League Roadmap.docx', 'docs\design',
  'seed\franchises.json', 'seed\managers.json',
  'seed\corrections\corrections.json'
)
foreach ($entry in $excluded) {
  $path = Join-Path "$stage\tree" $entry
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
}
~~~

Expected: code, migrations, tests, and synthetic seed examples remain; no source private or mock data remains.

- [ ] **Step 4: Copy the sanitized source into HallofBlamers**

~~~powershell
$target = 'C:\Users\hilde\OneDrive\Documents\HallofBlamers'
robocopy "$stage\tree" $target /E /COPY:DAT /DCOPY:DAT /NFL /NDL /NJH /NJS
if ($LASTEXITCODE -gt 7) { throw "robocopy failed with exit code $LASTEXITCODE" }
~~~

Expected: all runtime/test paths arrive and `docs/superpowers/` is retained.

- [ ] **Step 5: Check the import boundary**

~~~powershell
@('seed\franchises.json', 'seed\managers.json', 'seed\corrections\corrections.json', 'docs\design') |
  ForEach-Object {
    if (Test-Path -LiteralPath (Join-Path $target $_)) { throw "Excluded source content present: $_" }
  }
& 'C:\Program Files\Git\cmd\git.exe' -C $target status --short
~~~

Expected: imported source is untracked and all explicit exclusions are absent.

### Task 2: Rebrand the application, assets, tests, and operations

**Files:**

- Modify every HallofBlamers adaptation listed in File Structure.
- Create `AGENTS.md` and `scripts/verify-identity.mjs`.

**Interfaces:**

- Consumes the sanitized imported tree.
- Produces a Hall of Blamers package, wordmark, PWA identity, Docker image, docs, prompts, tests, and comments.

- [ ] **Step 1: Write the failing source-identity audit**

Create `scripts/verify-identity.mjs`:

~~~js
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const banned = [/west blue bell/i, /westbluebell\.com/i, /\bffootball\b/i, /BB_Football/i, /richey1406-prog/i];
const allowedPrefixes = ['docs/superpowers/'];
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0').filter(Boolean)
  .filter((file) => !allowedPrefixes.some((prefix) => file.startsWith(prefix)));
const violations = files.flatMap((file) => {
  const text = readFileSync(file, 'utf8');
  return banned.filter((pattern) => pattern.test(text)).map((pattern) => file + ': ' + String(pattern));
});
if (violations.length) throw new Error('Source identity remains:\n' + violations.join('\n'));
console.log('Identity audit passed for ' + files.length + ' tracked files.');
~~~

Add `"audit:identity": "node scripts/verify-identity.mjs"` to `package.json`.

- [ ] **Step 2: Run the audit before the fixes**

Run: `npm run audit:identity`

Expected: FAIL and report source-branded files.

- [ ] **Step 3: Make exact user-facing identity changes**

Apply these values:

~~~ts
// src/app/layout.tsx
title: { default: 'Hall of Blamers', template: 'Hall of Blamers — %s' }
description: "Hall of Blamers' own broadcast network."

// src/app/manifest.json
{ "name": "Hall of Blamers", "short_name": "HOB" }

// src/components/layout/TopNav.tsx and src/app/login/page.tsx
"Hall of Blamers"

// src/app/(league)/error.tsx
"Hall of Blamers hit a snag"
~~~

Set package and lockfile root name to `hallofblamers`. Change Docker image `ffootball:latest` to `hallofblamers:latest`. Change SVG `aria-label` values to `Hall of Blamers`. Replace source identity in comments, shell output, temporary test prefixes, test URLs, fixtures, and docs. Use `1690915927` for tests that intentionally model configured ESPN league identity.

- [ ] **Step 4: Write HallofBlamers agent guidance**

Create `AGENTS.md` with exact invariants: immutable snapshots → idempotent normalized data → transactionally rebuilt derived stats; pure `src/engines`; server-only DB reads; worker-only ESPN writes; dynamic SSR; deterministic event/achievement keys; franchise-centric statistics; and test/build/migration commands. Do not mention source managers, source operator details, or source domain.

- [ ] **Step 5: Rewrite configuration and operating documents**

Change `.env.example`, `README.md`, `docs/RUNBOOK.md`, `ops/setup.sh`, and `ops/deploy.sh` to name Hall of Blamers, use league ID `1690915927`, label repo/image folders `hallofblamers`, retain private-cookie and backup guidance, and instruct Cloudflare operators to enter their configured public hostname.

Keep `.env.example` blank except `ESPN_LEAGUE_ID=1690915927` and the safe session-secret placeholder.

- [ ] **Step 6: Verify then commit a clean first application snapshot**

~~~bash
npm run audit:identity
npm run typecheck
npm run lint
git add .
git commit -m "feat: initialize Hall of Blamers league hub"
~~~

Expected: audit, typecheck, and lint pass; the first application commit has no source identity or source data.

### Task 3: Establish a private Hall of Blamers bootstrap workflow

**Files:**

- Modify `.gitignore`, `seed/franchises.example.json`, `seed/managers.example.json`, `seed/corrections/corrections.example.json`, `.env.example`, and `docs/RUNBOOK.md`.
- Create `docs/HALLOFBLAMERS-BOOTSTRAP.md`.
- Generate only locally: `.env`, real seed files, corrections, and database.

**Interfaces:**

- Consumes `db:migrate`, `backfill`, `seed:suggest`, `normalize`, `stats:build`, and `seed:managers` commands.
- Produces a safe local path from private ESPN credentials to snapshots, reviewed franchise identity, stats, and manager logins.

- [ ] **Step 1: Extend the audit for tracked live seeds**

Add:

~~~js
const forbiddenTrackedPaths = new Set([
  'seed/franchises.json',
  'seed/managers.json',
  'seed/corrections/corrections.json',
]);
const trackedData = files.filter((file) => forbiddenTrackedPaths.has(file));
if (trackedData.length) throw new Error('Private league seed tracked: ' + trackedData.join(', '));
~~~

- [ ] **Step 2: Add private seed paths to `.gitignore`**

~~~gitignore
# Hall of Blamers private league mappings and corrections
seed/franchises.json
seed/managers.json
seed/corrections/corrections.json
~~~

Keep only synthetic examples tracked. Update example first-season references from 2018 to 2021; never add real Hall of Blamers franchise names, owner SWIDs, corrections, or managers.

- [ ] **Step 3: Document the exact bootstrap order**

Create `docs/HALLOFBLAMERS-BOOTSTRAP.md` with:

~~~bash
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
~~~

Explain that `seed:suggest` groups ESPN owner SWIDs, but a human must approve canonical franchises and ownership windows before normalization. Missing mappings are intentional hard validation failures.

- [ ] **Step 4: Verify the boundary and commit**

~~~bash
git ls-files seed
npm run audit:identity
git add .gitignore seed docs/HALLOFBLAMERS-BOOTSTRAP.md scripts/verify-identity.mjs
git commit -m "docs: add private Hall of Blamers bootstrap workflow"
~~~

Expected: only example seeds are tracked and audit passes.

### Task 4: Establish a no-secret verification baseline

**Files:**

- Verify `package.json`, `package-lock.json`, Vitest config, tests, and `scripts/verify-identity.mjs`.
- Modify only a transplant-caused portability issue with a corresponding focused test.

**Interfaces:**

- Consumes a rebranded codebase without `.env`, database, or real seed data.
- Produces confidence that generic engines and mocked server features work before live ESPN access.

- [ ] **Step 1: Install exactly the locked dependency tree**

Run: `npm ci`

Expected: successful install and no data/secret path becomes tracked.

- [ ] **Step 2: Run all imported tests**

Run: `npm test`

Expected: engine, feature, route, database, worker, and mocked ESPN tests pass.

- [ ] **Step 3: Run complete static verification**

~~~bash
npm run typecheck
npm run lint
npm run build
npm run audit:identity
~~~

Expected: every command exits 0; build does not require private cookies.

- [ ] **Step 4: Use TDD for a transplant-caused failure**

For each failure caused by Tasks 1–3: add or adjust one focused Vitest expectation, run it to prove failure, make the smallest change, then rerun the focused test plus `npm test`, typecheck, lint, build, and audit. Do not alter parsing, normalization, architecture, or UI behavior to compensate for the transplant.

- [ ] **Step 5: Commit only actual verification fixes**

~~~bash
git add package.json package-lock.json scripts src worker
git commit -m "test: verify Hall of Blamers transplant"
~~~

Skip this commit if no code/test files changed.

### Task 5: Connect private ESPN and derive Hall of Blamers data

**Files:**

- Generate locally only: `.env`, `data/league.db`, `seed/franchises.json`, `seed/managers.json`, optional `seed/corrections/corrections.json`.
- Read `docs/HALLOFBLAMERS-BOOTSTRAP.md`, `docs/RUNBOOK.md`, `src/server/sync/credentials.ts`, `src/server/sync/franchise-map.ts`, and `src/server/espn/backfill.ts`.

**Interfaces:**

- Consumes `ESPN_LEAGUE_ID=1690915927` plus `ESPN_S2` and `ESPN_SWID` supplied only by the authorized operator.
- Produces raw snapshots, reviewed franchise mapping, normalized data, derived statistics, and local manager invitations.

- [ ] **Step 1: Create private configuration without printing secrets**

Run `cp .env.example .env`. Set `SESSION_SECRET`, `ESPN_S2`, `ESPN_SWID`, optional `ANTHROPIC_API_KEY`, and optional `CLOUDFLARE_TUNNEL_TOKEN` in an interactive editor or `ops/setup.sh`. Verify `ESPN_LEAGUE_ID` remains `1690915927`. Do not paste any secret into terminal output.

- [ ] **Step 2: Test credentials with the first season**

~~~bash
npm run db:migrate
npm run backfill -- --from 2021 --to 2021 --league 1690915927
~~~

Expected: migrations succeed; the backfill returns `status: ok` and stores snapshots. If it returns `auth_failed`, refresh private cookies without changing source code.

- [ ] **Step 3: Backfill the complete history**

Run: `npm run backfill -- --from 2021 --to 2026 --league 1690915927`

Expected: all available season/period snapshots store. A partial run records failed requests and can safely be rerun after the external problem is fixed.

- [ ] **Step 4: Generate and review durable franchise identity**

Run: `npm run seed:suggest > seed/franchises.json`

Review every entry for canonical franchise identity, team renames, ownership changes, owner SWIDs, season windows, co-managers, and explicit season/team IDs. Do not copy a source-league seed row.

- [ ] **Step 5: Normalize and rebuild stats**

~~~bash
npm run normalize
npm run stats:build
~~~

Expected: every ESPN team resolves through the local seed; derived stats atomically swap in after full rebuild. Fix unmapped teams in the local seed, never by editing normalized database rows.

- [ ] **Step 6: Generate local invites**

Copy `seed/managers.example.json` to `seed/managers.json`, replace synthetic rows with Hall of Blamers manager/franchise IDs, then run `npm run seed:managers`. Do not stage the file or resulting URLs.

### Task 6: Verify feature parity and production-equivalent services

**Files:**

- Verify all league routes, live APIs, worker, `docker-compose.yml`, `ops/`, Runbook, and bootstrap document.
- Modify only a reproduced Hall of Blamers compatibility defect and test the exact affected module first.

**Interfaces:**

- Consumes completed snapshots, mapping, normalization, stats, and manager setup.
- Produces a self-hosted feature-complete site populated solely by Hall of Blamers data.

- [ ] **Step 1: Run authenticated user and commissioner smoke tests**

Start `npm run dev`, sign in with a local invite, and check:

~~~
/, /matchups, /standings, /history, /belt, /recaps, /polls,
/predictions, /pickem, /records, /seasons, /franchises, /h2h,
/timeline, and /admin as commissioner
~~~

Expected: every view shows Hall of Blamers data or its intentional empty state; no source wordmark, team, score, record, or manager is shown.

- [ ] **Step 2: Verify worker-only ESPN writes**

Run `npm run worker`. Observe a scheduled or commissioner-triggered run in `sync_runs`/`events`, then stop cleanly. Confirm the web process is not importing or normalizing ESPN data.

- [ ] **Step 3: Run Docker locally**

With a private local `.env`:

~~~bash
docker compose up -d --build
docker compose ps
./ops/status.sh
curl --fail http://127.0.0.1:3000/api/health
~~~

Expected: migrations complete; web is healthy; worker runs; health passes. Cloudflared may remain disabled locally without a token and must not block web/worker verification.

- [ ] **Step 4: Use TDD for an actual compatibility bug**

Reproduce a failed route/job/migration/service with an existing focused test or a new colocated test, verify it fails, implement the smallest architecture-preserving fix, then rerun the focused test, full suite, typecheck, lint, build, audit, and failed runtime command.

- [ ] **Step 5: Commit only a real compatibility fix**

~~~bash
git add src worker ops docker-compose.yml docs package.json package-lock.json
git commit -m "fix: support Hall of Blamers ESPN import"
~~~

Never stage `.env`, `data`, or local seed files.

### Task 7: Release-gate the repository and push the clean project

**Files:**

- Verify complete tracked tree, `.gitignore`, `scripts/verify-identity.mjs`, remote, and operating docs.

**Interfaces:**

- Consumes every prior task.
- Produces a clean HallofBlamers repository ready for independent operation.

- [ ] **Step 1: Run the release gate**

~~~bash
npm test
npm run typecheck
npm run lint
npm run build
npm run audit:identity
git status --short
~~~

Expected: all validation passes and only intended code/docs changes are tracked.

- [ ] **Step 2: Prove private data is ignored**

~~~bash
git ls-files .env data seed/franchises.json seed/managers.json seed/corrections/corrections.json
git check-ignore .env data/league.db seed/franchises.json seed/managers.json seed/corrections/corrections.json
~~~

Expected: the first command returns nothing; the second command identifies each private artifact as ignored.

- [ ] **Step 3: Verify history and remote**

~~~bash
git log --oneline --decorate --max-count=10
git remote -v
~~~

Expected: history begins with HallofBlamers-only commits and origin is `https://github.com/Chilldebrand/HallofBlamers.git`.

- [ ] **Step 4: Push verified main**

~~~bash
git push -u origin main
~~~

Expected: Chilldebrand/HallofBlamers receives the clean project with no secrets or league data.

- [ ] **Step 5: Correct only safe operating documentation**

Update `docs/HALLOFBLAMERS-BOOTSTRAP.md` only if real execution exposed a missing command or inaccurate expected result. Never add cookies, owner SWIDs, managers, invite tokens, raw ESPN data, or a production hostname.

## Plan Self-Review

**Spec coverage:** Task 1 delivers source/feature parity; Task 2 implements Hall of Blamers identity and preserved UI; Task 3 protects data; Task 5 connects ESPN and imports the 2021-current history; Task 6 verifies every user/commissioner surface and Docker; Task 7 proves quality, privacy, clean history, and target remote.

**Placeholder scan:** Source revision, paths, commands, league ID, season range, exclusions, expected results, and test gates are explicit. Credentials and hostname are intentionally omitted because they are private operator inputs.

**Interface consistency:** `db:migrate`, `backfill`, `seed:suggest`, `normalize`, `stats:build`, `seed:managers`, and `worker` names match package scripts and are used consistently. ESPN-derived writes remain worker/sync-owned.

