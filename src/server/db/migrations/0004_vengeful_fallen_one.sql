CREATE TABLE `context_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL,
	`subject_type` text NOT NULL,
	`season` integer NOT NULL,
	`week` integer NOT NULL,
	`franchise_id` integer,
	`matchup_id` integer,
	`rule_id` text NOT NULL,
	`salience` integer NOT NULL,
	`rendered_text` text NOT NULL,
	`facts_json` text,
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `context_notes_season_week_idx` ON `context_notes` (`season`,`week`);--> statement-breakpoint
CREATE INDEX `context_notes_matchup_id_idx` ON `context_notes` (`matchup_id`);--> statement-breakpoint
CREATE INDEX `context_notes_franchise_id_season_week_idx` ON `context_notes` (`franchise_id`,`season`,`week`);