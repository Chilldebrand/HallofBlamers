CREATE TABLE `belt_matches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL,
	`matchup_id` integer NOT NULL,
	`season` integer NOT NULL,
	`week` integer NOT NULL,
	`holder_franchise_id` integer NOT NULL,
	`challenger_franchise_id` integer NOT NULL,
	`result` text NOT NULL,
	`holder_score` real NOT NULL,
	`challenger_score` real NOT NULL,
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`matchup_id`) REFERENCES `matchups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`holder_franchise_id`) REFERENCES `franchises`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`challenger_franchise_id`) REFERENCES `franchises`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `belt_matches_matchup_id_unique` ON `belt_matches` (`matchup_id`);--> statement-breakpoint
CREATE TABLE `belt_reigns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL,
	`reign_no` integer NOT NULL,
	`franchise_id` integer NOT NULL,
	`won_from_franchise_id` integer,
	`start_season` integer NOT NULL,
	`start_week` integer NOT NULL,
	`end_season` integer,
	`end_week` integer,
	`defenses` integer NOT NULL,
	`weeks_held` integer NOT NULL,
	`end_reason` text,
	`is_current` integer NOT NULL,
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`franchise_id`) REFERENCES `franchises`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`won_from_franchise_id`) REFERENCES `franchises`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `belt_reigns_reign_no_unique` ON `belt_reigns` (`reign_no`);--> statement-breakpoint
CREATE TABLE `career_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL,
	`franchise_id` integer NOT NULL,
	`seasons` integer NOT NULL,
	`wins` integer NOT NULL,
	`losses` integer NOT NULL,
	`ties` integer NOT NULL,
	`win_pct` real NOT NULL,
	`points_for` real NOT NULL,
	`points_against` real NOT NULL,
	`allplay_w` integer NOT NULL,
	`allplay_l` integer NOT NULL,
	`allplay_t` integer NOT NULL,
	`championships` integer NOT NULL,
	`sackos` integer NOT NULL,
	`playoff_appearances` integer NOT NULL,
	`best_finish` integer,
	`worst_finish` integer,
	`highest_week` real,
	`highest_week_season` integer,
	`highest_week_week` integer,
	`lowest_week` real,
	`lowest_week_season` integer,
	`lowest_week_week` integer,
	`longest_win_streak` integer,
	`longest_win_streak_start_season` integer,
	`longest_win_streak_start_week` integer,
	`longest_win_streak_end_season` integer,
	`longest_win_streak_end_week` integer,
	`longest_loss_streak` integer,
	`longest_loss_streak_start_season` integer,
	`longest_loss_streak_start_week` integer,
	`longest_loss_streak_end_season` integer,
	`longest_loss_streak_end_week` integer,
	`current_elo` real NOT NULL,
	`peak_elo` real NOT NULL,
	`luck_total` real,
	`expected_wins` real,
	`efficiency_avg` real,
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`franchise_id`) REFERENCES `franchises`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `career_stats_franchise_id_unique` ON `career_stats` (`franchise_id`);--> statement-breakpoint
CREATE TABLE `elo_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL,
	`season` integer NOT NULL,
	`week` integer NOT NULL,
	`franchise_id` integer NOT NULL,
	`elo_pre` real NOT NULL,
	`elo_post` real NOT NULL,
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`franchise_id`) REFERENCES `franchises`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `elo_history_season_week_franchise_id_unique` ON `elo_history` (`season`,`week`,`franchise_id`);--> statement-breakpoint
CREATE TABLE `franchise_elo` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL,
	`franchise_id` integer NOT NULL,
	`current` real NOT NULL,
	`peak` real NOT NULL,
	`peak_season` integer NOT NULL,
	`peak_week` integer NOT NULL,
	`trough` real NOT NULL,
	`weeks_at_no1` integer NOT NULL,
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`franchise_id`) REFERENCES `franchises`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `franchise_elo_franchise_id_unique` ON `franchise_elo` (`franchise_id`);--> statement-breakpoint
CREATE TABLE `h2h_pairs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL,
	`franchise_a` integer NOT NULL,
	`franchise_b` integer NOT NULL,
	`reg_w` integer NOT NULL,
	`reg_l` integer NOT NULL,
	`reg_t` integer NOT NULL,
	`playoff_w` integer NOT NULL,
	`playoff_l` integer NOT NULL,
	`playoff_t` integer NOT NULL,
	`points_a` real NOT NULL,
	`points_b` real NOT NULL,
	`avg_margin` real NOT NULL,
	`streak_holder` integer,
	`streak_len` integer NOT NULL,
	`largest_win_json` text,
	`closest_game_json` text,
	`last_meeting_json` text,
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`franchise_a`) REFERENCES `franchises`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`franchise_b`) REFERENCES `franchises`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`streak_holder`) REFERENCES `franchises`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `h2h_pairs_franchise_a_franchise_b_unique` ON `h2h_pairs` (`franchise_a`,`franchise_b`);--> statement-breakpoint
CREATE TABLE `record_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL,
	`record_key` text NOT NULL,
	`rank` integer NOT NULL,
	`franchise_id` integer NOT NULL,
	`season` integer NOT NULL,
	`week` integer,
	`value` real NOT NULL,
	`week_type` text,
	`detail_json` text,
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`franchise_id`) REFERENCES `franchises`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `record_entries_record_key_rank_franchise_id_season_week_unique` ON `record_entries` (`record_key`,`rank`,`franchise_id`,`season`,`week`);--> statement-breakpoint
CREATE TABLE `season_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL,
	`season` integer NOT NULL,
	`franchise_id` integer NOT NULL,
	`wins` integer NOT NULL,
	`losses` integer NOT NULL,
	`ties` integer NOT NULL,
	`points_for` real NOT NULL,
	`points_against` real NOT NULL,
	`allplay_w` integer NOT NULL,
	`allplay_l` integer NOT NULL,
	`allplay_t` integer NOT NULL,
	`luck_total` real,
	`expected_wins` real,
	`efficiency_avg` real,
	`final_standing` integer,
	`made_playoffs` integer NOT NULL,
	`champion` integer DEFAULT false NOT NULL,
	`sacko` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`franchise_id`) REFERENCES `franchises`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `season_stats_season_franchise_id_unique` ON `season_stats` (`season`,`franchise_id`);