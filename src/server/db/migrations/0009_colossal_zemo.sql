-- INTEGRATION CONSTRAINT: this migration's meta/_journal.json entry (idx 9) has its `when` field
-- hand-set to EXACTLY 1785900000009 — a pre-assigned slot, not drizzle-kit's auto-generated
-- timestamp. See 0008_first_reaper.sql's own INTEGRATION CONSTRAINT comment for the underlying
-- hazard: drizzle's migrator (drizzle-orm/sqlite-core/dialect.js) gates purely on `journalEntry.when`
-- being strictly greater than the LAST-applied migration's recorded `created_at` — never on a set
-- of already-applied hashes. Multiple task branches were developed in parallel worktrees, each
-- potentially generating its own next-index migration with a real "generate time" `when` that could
-- land in the wrong relative order once every branch merges into one linear history. Pre-assigning
-- each slot a deliberately round, strictly-increasing `when` (0009 here; higher slots for whichever
-- branches claim 0010+) guarantees correct apply order regardless of each branch's real wall-clock
-- generation time. Also fixed as part of landing this migration (not a byproduct of it): 0008's own
-- meta/0008_snapshot.json had a stale `prevId` pointing at 0006 instead of 0007 — a genuine fork in
-- drizzle-kit's snapshot lineage graph left over from 0007 (achievements-engine) and 0008
-- (recap-voice-learning) having been generated independently in parallel worktrees before either was
-- merged, which made `drizzle-kit generate` refuse to run at all ("collision"). Corrected by merging
-- 0007_snapshot.json's `achievements` table entry into 0008_snapshot.json and repointing its
-- `prevId` at 0007's id — snapshot files are drizzle-kit codegen bookkeeping ONLY (never read by
-- the runtime migrator, which reads solely from _journal.json + these .sql files — see
-- drizzle-orm/migrator.js's readMigrationFiles), so this fix carries zero risk to any already-applied
-- database; it only unblocks future `drizzle-kit generate` runs from a correct baseline.
CREATE TABLE `predictions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`manager_id` integer NOT NULL,
	`season` integer NOT NULL,
	`category` text NOT NULL,
	`subject` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`manager_id`) REFERENCES `managers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `predictions_season_idx` ON `predictions` (`season`);--> statement-breakpoint
CREATE UNIQUE INDEX `predictions_manager_season_category_unique` ON `predictions` (`manager_id`,`season`,`category`);