CREATE TABLE `achievements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL,
	`achievement_key` text NOT NULL,
	`franchise_id` integer NOT NULL,
	`season` integer NOT NULL,
	`week` integer NOT NULL,
	`dedupe_key` text NOT NULL,
	`payload_json` text,
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `achievements_franchise_id_idx` ON `achievements` (`franchise_id`);--> statement-breakpoint
CREATE INDEX `achievements_season_week_idx` ON `achievements` (`season`,`week`);--> statement-breakpoint
CREATE INDEX `achievements_achievement_key_idx` ON `achievements` (`achievement_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `achievements_dedupe_key_unique` ON `achievements` (`dedupe_key`);