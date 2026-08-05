# Hall of Blamers — Clean BB_Football Transplant

## Purpose

Create Hall of Blamers as an independent, feature-complete ESPN fantasy-football league site by transplanting the current `main` code snapshot of `richey1406-prog/BB_Football` into `Chilldebrand/HallofBlamers`.

The result preserves the reference application's architecture, feature set, and visual system while using only Hall of Blamers identity, configuration, credentials, data, and deployment resources.

## Scope

- **League:** Hall of Blamers
- **ESPN league ID:** `1690915927`
- **Access:** Private ESPN league; credentials are `espn_s2` and `SWID` stored only in environment/database configuration.
- **Historical import:** 2021 through the current season.
- **Delivery model:** Standalone application, self-hosted with Docker Compose, a separate sync worker, SQLite, and Cloudflare Tunnel.
- **Parity target:** Every current BB_Football feature and the existing UI/interaction design.
- **Repository:** A clean Git history in `Chilldebrand/HallofBlamers`; BB_Football's history is not retained.

## Architecture

HallofBlamers retains the reference stack and its load-bearing boundaries:

- Next.js App Router, React Server Components, TypeScript strict, Tailwind CSS, and Motion.
- SQLite through better-sqlite3 and Drizzle migrations.
- A web process and a separate worker process coordinated only through the database.
- Docker Compose services for migration, web, worker, and Cloudflare Tunnel.
- Pure, testable league-statistics engines with no database or network access.

The project retains three data layers:

1. Immutable raw ESPN snapshots are stored before use.
2. Normalized season, franchise, manager, roster, and matchup data is rebuilt idempotently from snapshots.
3. Derived records, Elo, luck, efficiency, achievements, belt history, and other statistics are rebuilt transactionally from normalized data.

The worker is the only process permitted to write ESPN-derived data. The web process serves dynamic data and uses server actions for protected commissioner operations.

## Product and interface

The application preserves the reference visual system: responsive desktop/phone layouts, light and dark modes, kelly-green editorial sports styling, live ticker, scoreboards, identity treatments, and reduced-motion behavior.

Hall of Blamers replaces all BB_Football league-specific identity, including the league name, repository references, domains, configuration, and operating documentation. General league mechanics and labels such as champion, belt, Sacko, Pick'em, and The Algorithm remain intact unless Hall of Blamers-specific configuration makes a data-driven change necessary.

Feature parity includes:

- Home dashboard, live scores, matchup hubs, matchup details, and box scores.
- Real, all-play, and luck standings.
- League history, franchise profiles, Elo, records, streaks, efficiency, and head-to-head views.
- Championship belt history and transfers.
- Recaps, optional AI recap generation, polls, preseason predictions, weekly Pick'em, and The Algorithm.
- Achievements and champion, belt-holder, Sacko, and signed-in-manager identity signals.
- Manager authentication, invitations, commissioner administration, manual sync, and operational tools.
- Scheduled syncs, historical backfills, corrections, full stats rebuilds, backups, health checks, and runbooks.

## Isolation and configuration

HallofBlamers starts with a fresh database and contains no BB_Football league data, managers, sessions, secrets, generated events, statistics, achievements, domain, or deployment credentials.

Required runtime configuration includes:

- `ESPN_LEAGUE_ID=1690915927`
- Private ESPN `ESPN_S2` and `ESPN_SWID` cookies
- A new session secret
- Optional AI API key
- A Hall of Blamers Cloudflare Tunnel token and public hostname

Secrets remain in `.env` or rotatable database settings and are excluded from Git.

## Error handling and operations

Imports run through the worker and preserve the last known-good database state if an ESPN request, normalization pass, or derived-stats rebuild fails. Sync status and recovery actions remain visible to commissioners without exposing credentials.

Production startup follows the existing order: migrations must succeed, then web and worker start, then Cloudflare Tunnel routes verified web traffic. Backup, health-check, restore, and manual-sync procedures are retained and renamed for Hall of Blamers.

## Verification and acceptance criteria

The transplant is ready when all of the following are true:

1. Unit tests, type checking, linting, and the production build pass.
2. Migrations apply successfully to a fresh Hall of Blamers database.
3. Private ESPN authentication succeeds for league `1690915927`.
4. A 2021-to-current-season backfill completes, then normalized and derived data rebuild successfully.
5. Every user and commissioner feature is reachable and behaves as in BB_Football.
6. The inherited responsive UI and accessibility behavior remain intact.
7. Repository-wide validation finds no BB_Football secrets, league data, manager identities, West Blue Bell branding, old domain, or old repository references.
8. Docker services, health checks, sync procedures, and backups operate under the Hall of Blamers configuration.
9. The repository has a clean HallofBlamers-only history and remote.

## Non-goals

- Creating a shared multi-league product.
- Preserving BB_Football commit history.
- Copying any BB_Football database, ESPN credentials, manager information, results, generated content, or deployment configuration.
- Redesigning the existing interface or selectively omitting existing features.
