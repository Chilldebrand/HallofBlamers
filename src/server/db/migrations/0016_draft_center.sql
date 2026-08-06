CREATE TABLE `draft_grades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL,
	`season` integer NOT NULL,
	`franchise_id` integer NOT NULL,
	`pick_count` integer NOT NULL,
	`total_value` real NOT NULL,
	`avg_reach_steal_score` real NOT NULL,
	`avg_reach_steal_pct` real NOT NULL,
	`z_score` real NOT NULL,
	`grade` text NOT NULL,
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `draft_grades_season_franchise_id_unique` ON `draft_grades` (`season`,`franchise_id`);--> statement-breakpoint
CREATE TABLE `draft_pick_values` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL,
	`season` integer NOT NULL,
	`draft_pick_id` integer NOT NULL,
	`franchise_id` integer NOT NULL,
	`team_season_id` integer NOT NULL,
	`player_id` integer NOT NULL,
	`round` integer NOT NULL,
	`round_pick` integer NOT NULL,
	`overall_pick` integer NOT NULL,
	`value` real NOT NULL,
	`value_rank` integer NOT NULL,
	`total_ranked_picks` integer NOT NULL,
	`reach_steal_score` integer NOT NULL,
	`reach_steal_pct` real NOT NULL,
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`espn_player_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `draft_pick_values_season_idx` ON `draft_pick_values` (`season`);--> statement-breakpoint
CREATE INDEX `draft_pick_values_franchise_id_season_idx` ON `draft_pick_values` (`franchise_id`,`season`);--> statement-breakpoint
CREATE UNIQUE INDEX `draft_pick_values_draft_pick_id_unique` ON `draft_pick_values` (`draft_pick_id`);
