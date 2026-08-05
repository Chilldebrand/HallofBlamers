-- INTEGRATION CONSTRAINT (fix round 1, reviewer-flagged Critical): this migration must land
-- AFTER the parked achievements-engine branch's 0007 migration is merged and migrated in this
-- repo's history — drizzle's migrator gates purely on each journal entry's `when` timestamp
-- ordering relative to what's already applied, so if 0008 (this file) is applied first, 0007's
-- later merge would be silently skipped as "older than the last-applied migration" instead of
-- running. No code change resolves this; it's a hard merge-order requirement enforced by the
-- controller at integration time, not by anything in this file.
CREATE TABLE `recap_exemplars` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recap_id` integer NOT NULL,
	`season` integer NOT NULL,
	`week` integer NOT NULL,
	`style` text NOT NULL,
	`draft_md` text NOT NULL,
	`published_md` text NOT NULL,
	`captured_at` integer NOT NULL,
	FOREIGN KEY (`recap_id`) REFERENCES `recaps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recap_exemplars_recap_id_unique` ON `recap_exemplars` (`recap_id`);--> statement-breakpoint
CREATE INDEX `recap_exemplars_captured_at_idx` ON `recap_exemplars` (`captured_at`);--> statement-breakpoint
CREATE TABLE `recap_style_guides` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guide_text` text NOT NULL,
	`exemplar_count` integer NOT NULL,
	`source_recap_ids` text NOT NULL,
	`model` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`cost_usd` real,
	`is_active` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recap_style_guides_is_active_idx` ON `recap_style_guides` (`is_active`);--> statement-breakpoint
ALTER TABLE `recaps` ADD `markdown_generated` text;--> statement-breakpoint
-- Hand-added (not drizzle-kit generated): backfill `markdown_generated` for every EXISTING recap
-- row from its current `markdown_draft`. Correct for any row that hasn't been edited yet as of
-- this migration (markdown_draft still IS the as-generated text) — e.g. recap id 1, a real 2025
-- wk17 draft sitting untouched at the time this migration was written. For a row that was ALREADY
-- edited/published before this migration ran, this backfill can't recover the true original (it
-- was never stored) — the WHERE clause still fires for it since markdown_generated starts NULL,
-- so it gets backfilled from the (already-edited) current markdown_draft too. That's a deliberate,
-- safe under-approximation: worst case, that one row's very NEXT edit-then-publish cycle won't be
-- captured as an exemplar either (nothing to diff against would look identical), never a false
-- "revision" fabricated from data that was never actually captured.
UPDATE `recaps` SET `markdown_generated` = `markdown_draft` WHERE `markdown_generated` IS NULL AND `markdown_draft` IS NOT NULL;