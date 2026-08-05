-- SLOT RESERVED AS 0011 (Task 32, win-probability engine): the merge-train sequencing this repo's
-- controller uses for parallel task branches means slots 0009 and 0010 are reserved for two OTHER
-- in-flight tasks that had not yet produced their own migrations at the time this one was written.
-- This file's numbering, the journal's `idx: 11`, and its `"when": 1785900000011` timestamp are all
-- deliberately set so this migration lands AFTER 0009 and 0010 once the controller integrates all
-- three — same hard requirement (and same reason: drizzle's migrator gates on each journal entry's
-- `when` ordering relative to what's already applied, not on filename order) that 0008's own
-- INTEGRATION CONSTRAINT comment documents for the achievements-engine/recap-voice-learning pair. No
-- code change resolves this; it's enforced by the controller at integration time.
--
-- NOT drizzle-kit generated: `drizzle-kit generate` currently fails in this worktree with a snapshot
-- collision between meta/0007_snapshot.json and meta/0008_snapshot.json (both declare the same
-- `prevId`, i.e. both were generated independently off the same parent snapshot on separate task
-- branches before being merged into a single migration history) — a pre-existing artifact of the
-- parallel-branch merge process, not something this task introduced or attempts to fix. This file
-- and its `meta/_journal.json` entry were hand-written instead, following the exact precedent 0008
-- itself sets for a hand-added statement (see 0008's own backfill UPDATE). `runMigrations`
-- (`drizzle-orm/better-sqlite3/migrator`) only ever reads `meta/_journal.json` + each migration's
-- `.sql` file at runtime — it does not consult the `meta/NNNN_snapshot.json` diffing artifacts at
-- all — so this is sufficient for every real migration run; no `meta/0011_snapshot.json` was added,
-- to avoid hand-fabricating a large diffing artifact `drizzle-kit` itself cannot currently produce or
-- validate against the already-broken 0007/0008 chain.
CREATE TABLE `slot_scoring_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL,
	`slot` text NOT NULL,
	`mean` real NOT NULL,
	`variance` real NOT NULL,
	`sample_size` integer NOT NULL,
	`season_min` integer NOT NULL,
	`season_max` integer NOT NULL,
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slot_scoring_stats_slot_unique` ON `slot_scoring_stats` (`slot`);
