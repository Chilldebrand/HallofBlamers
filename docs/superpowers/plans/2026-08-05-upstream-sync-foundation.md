# Upstream Synchronization Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the database, runtime, and dependency base needed to transplant all applicable BB_Football changes through upstream commit `12c8876` without altering Hall of Blamers identity or local league data.

**Architecture:** This is plan 1 of 4. It imports the upstream migration chain and shared schema because they are league-neutral, then brings over Node 24/runtime dependencies with Hall of Blamers metadata and environment behavior retained. The existing private SQLite database is backed up and migrated only through app-owned commands.

**Tech Stack:** Next.js 16, TypeScript, Drizzle ORM, SQLite/better-sqlite3, tsx, Docker Compose, Node 24.

## Global Constraints

- Source reference is `C:\Users\hilde\AppData\Local\Temp\hallofblamers-bb-football-reference`; compare `d72bbb0..12c8876`.
- Preserve Hall of Blamers identity, private ESPN league data, local seed files, database, invite-link auth, and uncommitted `AGENTS.md`.
- Never copy upstream credentials, seeds, snapshots, databases, Git metadata, source-league copy, or identity assets.
- Keep Discord, web-push, and other third-party integrations configuration-disabled until their own secrets are explicitly supplied.
- Standalone `tsx` commands use `--env-file-if-exists=.env`.

---

### Task 1: Import the upstream database schema and migration contract

**Files:**

- Modify: `src/server/db/schema.ts`
- Modify: `src/server/db/__tests__/schema.test.ts`
- Create: `src/server/db/migrations/0012_waiver_trade_analytics.sql` through `0021_transaction_items_and_trade_ledger_source.sql`
- Create: `src/server/db/migrations/meta/0012_snapshot.json` through `0021_snapshot.json`
- Modify: `src/server/db/migrations/meta/_journal.json`

**Interfaces:**

- Produces Drizzle exports for `waiverAcquisitions`, `tradeLedger`, `revengeEvents`, `pushSubscriptions`, `notificationPrefs`, `chatMessages`, `podcastEpisodes`, `previewEpisodes`, `draftPickValues`, `draftGrades`, and `playoffOdds`.
- Adds PIN columns to `managers` and a source discriminator to transaction items without changing existing invite-session behavior.

- [ ] **Step 1: Bring in the focused upstream schema test before the implementation**

```powershell
npm.cmd test -- src/server/db/__tests__/schema.test.ts
```

Before running the command, use `apply_patch` to add the following table names to the expected sorted
list in the existing test: `chat_messages`, `draft_grades`, `draft_pick_values`,
`notification_prefs`, `playoff_odds`, `podcast_episodes`, `preview_episodes`,
`push_subscriptions`, `revenge_events`, `trade_ledger`, and `waiver_acquisitions`.

Expected: FAIL because the migration chain does not yet create the newly asserted tables.

- [ ] **Step 2: Apply only the exact upstream schema/migration delta**

```powershell
$reference = 'C:\Users\hilde\AppData\Local\Temp\hallofblamers-bb-football-reference'
& 'C:\Program Files\Git\cmd\git.exe' -c safe.directory='C:/Users/hilde/AppData/Local/Temp/hallofblamers-bb-football-reference' -C $reference diff d72bbb0b25887e91c4ad256de4957d330126726f..12c88763e4dfa7211b86146f942090a7327a93e5 -- src/server/db/schema.ts src/server/db/migrations
```

Use the displayed, league-neutral upstream delta as the source and reproduce it with `apply_patch`.
Do not overwrite Hall of Blamers-only files.

- [ ] **Step 3: Verify the contract passes**

```powershell
npm.cmd test -- src/server/db/__tests__/schema.test.ts
npm.cmd run typecheck
```

Expected: PASS and zero TypeScript errors.

- [ ] **Step 4: Commit the schema foundation**

```powershell
git add src/server/db/schema.ts src/server/db/__tests__/schema.test.ts src/server/db/migrations
git commit -m "feat: add upstream data platform schema"
```

### Task 2: Synchronize runtime/dependency support without source identity

**Files:**

- Modify: `package.json`, `package-lock.json`, `Dockerfile`, `docker-compose.yml`, `.env.example`, `.gitignore`
- Create: `scripts/generate-icons.mjs`

**Interfaces:**

- Produces Node 24 container images and optional VAPID placeholders.
- Adds upstream `discord.js`, `web-push`, `sharp`, and `@types/web-push` dependencies.
- Adds `playoffodds:backtest` and `icons:generate`; all existing tsx scripts load an existing `.env`.

- [ ] **Step 1: Apply the upstream runtime delta while keeping Hall of Blamers package identity**

```powershell
$reference = 'C:\Users\hilde\AppData\Local\Temp\hallofblamers-bb-football-reference'
& 'C:\Program Files\Git\cmd\git.exe' -c safe.directory='C:/Users/hilde/AppData/Local/Temp/hallofblamers-bb-football-reference' -C $reference diff d72bbb0b25887e91c4ad256de4957d330126726f..12c88763e4dfa7211b86146f942090a7327a93e5 -- package.json package-lock.json Dockerfile docker-compose.yml .env.example .gitignore scripts/generate-icons.mjs
```

Use `apply_patch` to reproduce the displayed runtime delta, retaining Hall of Blamers package name,
league ID example, and identity assets.

- [ ] **Step 2: Correct the CLI commands to load local `.env` files**

```json
{
  "scripts": {
    "db:migrate": "tsx --env-file-if-exists=.env src/server/db/migrate.ts",
    "worker": "tsx --env-file-if-exists=.env worker/index.ts",
    "backfill": "tsx --env-file-if-exists=.env src/server/espn/backfill.ts",
    "normalize": "tsx --env-file-if-exists=.env src/server/sync/normalize-cli.ts",
    "stats:build": "tsx --env-file-if-exists=.env src/server/stats/run-build.ts"
  }
}
```

Apply the same `--env-file-if-exists=.env` prefix to every remaining `tsx` script. Keep the Hall of Blamers package name and ESPN example ID; add only blank VAPID placeholders.

- [ ] **Step 3: Install and verify**

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd run lint
```

Expected: all commands exit zero.

- [ ] **Step 4: Commit runtime support**

```powershell
git add package.json package-lock.json Dockerfile docker-compose.yml .env.example .gitignore scripts/generate-icons.mjs
git commit -m "chore: align runtime with upstream platform"
```

### Task 3: Migrate the private Hall of Blamers database safely

**Files:**

- Modify: ignored `data/league.db` through application migration commands only
- Create: ignored `data/backups/` SQLite backup through the application backup command

**Interfaces:**

- Consumes migrations `0012` through `0021`.
- Produces the new empty platform tables while retaining archived ESPN snapshots, normalized history, manager access, and stored credentials.

- [ ] **Step 1: Record non-secret baselines and make a backup**

```powershell
node -e "const Database=require('better-sqlite3');const db=new Database('./data/league.db',{readonly:true});console.log(JSON.stringify({snapshots:db.prepare('select count(*) as n from snapshots').get().n,seasons:db.prepare('select count(*) as n from seasons').get().n,managers:db.prepare('select count(*) as n from managers').get().n}));"
npm.cmd run backup
```

Expected: all three counts are nonzero and a new ignored backup exists.

- [ ] **Step 2: Run migrations and verify new tables**

```powershell
npm.cmd run db:migrate
node -e "const Database=require('better-sqlite3');const db=new Database('./data/league.db',{readonly:true});const rows=db.prepare(\"select name from sqlite_master where type='table' and name in ('waiver_acquisitions','trade_ledger','push_subscriptions','chat_messages','podcast_episodes','draft_pick_values','revenge_events','playoff_odds')\").all();console.log(JSON.stringify(rows));if(rows.length!==8)process.exit(1);"
```

Expected: all eight tables exist; rerun the Step 1 count query and confirm the baseline values are unchanged.

- [ ] **Step 3: Commit only versioned work**

```powershell
git status --short
git commit --allow-empty -m "chore: verify upstream schema migration locally"
```

Ignored database/backup files must not be staged.

### Task 4: Verify the foundation before feature waves

**Files:**

- Modify: this plan by checking completed boxes only

**Interfaces:**

- Produces a verified base for Analytics and Archive, Engagement and Media, then Experience and Safeguards sync plans.

- [ ] **Step 1: Run complete static/unit verification**

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run audit:identity
```

Expected: exit zero; the existing Vite native-config deprecation warning is not a test failure.

- [ ] **Step 2: Build and verify existing history remains present**

```powershell
npm.cmd run build
node -e "const Database=require('better-sqlite3');const db=new Database('./data/league.db',{readonly:true});const rows=db.prepare('select season,count(*) as n from matchups group by season order by season').all();console.log(JSON.stringify(rows));if(rows.length<6||rows.some(r=>r.n===0))process.exit(1);"
```

Expected: production build passes and every imported season has matchups.

- [ ] **Step 3: Commit checked plan state**

```powershell
git add docs/superpowers/plans/2026-08-05-upstream-sync-foundation.md
git commit -m "docs: record upstream foundation verification"
```

## Follow-on plans

1. Analytics and Archive: waiver/trade center, what-if, Sweat Meter, data export/corrections, identity marks, Hall of Fame/Shame, Draft Center, Revenge, and Playoff Odds.
2. Engagement and Media: PWA/push, chat, Discord, podcast scripts, story cards, previews, manager tendencies, and newsletters.
3. Experience and Safeguards: navigation, optional invite-gated PIN login, live-week fixes, trade recovery, operations, and the final brand sweep.
