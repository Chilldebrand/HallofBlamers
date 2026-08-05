PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_allplay_week` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL,
	`season` integer NOT NULL,
	`week` integer NOT NULL,
	`franchise_id` integer NOT NULL,
	`wins` integer NOT NULL,
	`losses` integer NOT NULL,
	`ties` integer NOT NULL,
	`luck_score` real,
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_allplay_week`("id", "build_id", "season", "week", "franchise_id", "wins", "losses", "ties", "luck_score") SELECT "id", "build_id", "season", "week", "franchise_id", "wins", "losses", "ties", "luck_score" FROM `allplay_week`;--> statement-breakpoint
DROP TABLE `allplay_week`;--> statement-breakpoint
ALTER TABLE `__new_allplay_week` RENAME TO `allplay_week`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `allplay_week_season_week_franchise_id_unique` ON `allplay_week` (`season`,`week`,`franchise_id`);--> statement-breakpoint
CREATE TABLE `__new_belt_matches` (
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
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_belt_matches`("id", "build_id", "matchup_id", "season", "week", "holder_franchise_id", "challenger_franchise_id", "result", "holder_score", "challenger_score") SELECT "id", "build_id", "matchup_id", "season", "week", "holder_franchise_id", "challenger_franchise_id", "result", "holder_score", "challenger_score" FROM `belt_matches`;--> statement-breakpoint
DROP TABLE `belt_matches`;--> statement-breakpoint
ALTER TABLE `__new_belt_matches` RENAME TO `belt_matches`;--> statement-breakpoint
CREATE UNIQUE INDEX `belt_matches_matchup_id_unique` ON `belt_matches` (`matchup_id`);--> statement-breakpoint
CREATE TABLE `__new_belt_reigns` (
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
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_belt_reigns`("id", "build_id", "reign_no", "franchise_id", "won_from_franchise_id", "start_season", "start_week", "end_season", "end_week", "defenses", "weeks_held", "end_reason", "is_current") SELECT "id", "build_id", "reign_no", "franchise_id", "won_from_franchise_id", "start_season", "start_week", "end_season", "end_week", "defenses", "weeks_held", "end_reason", "is_current" FROM `belt_reigns`;--> statement-breakpoint
DROP TABLE `belt_reigns`;--> statement-breakpoint
ALTER TABLE `__new_belt_reigns` RENAME TO `belt_reigns`;--> statement-breakpoint
CREATE UNIQUE INDEX `belt_reigns_reign_no_unique` ON `belt_reigns` (`reign_no`);--> statement-breakpoint
CREATE TABLE `__new_career_stats` (
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
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_career_stats`("id", "build_id", "franchise_id", "seasons", "wins", "losses", "ties", "win_pct", "points_for", "points_against", "allplay_w", "allplay_l", "allplay_t", "championships", "sackos", "playoff_appearances", "best_finish", "worst_finish", "highest_week", "highest_week_season", "highest_week_week", "lowest_week", "lowest_week_season", "lowest_week_week", "longest_win_streak", "longest_win_streak_start_season", "longest_win_streak_start_week", "longest_win_streak_end_season", "longest_win_streak_end_week", "longest_loss_streak", "longest_loss_streak_start_season", "longest_loss_streak_start_week", "longest_loss_streak_end_season", "longest_loss_streak_end_week", "current_elo", "peak_elo", "luck_total", "expected_wins", "efficiency_avg") SELECT "id", "build_id", "franchise_id", "seasons", "wins", "losses", "ties", "win_pct", "points_for", "points_against", "allplay_w", "allplay_l", "allplay_t", "championships", "sackos", "playoff_appearances", "best_finish", "worst_finish", "highest_week", "highest_week_season", "highest_week_week", "lowest_week", "lowest_week_season", "lowest_week_week", "longest_win_streak", "longest_win_streak_start_season", "longest_win_streak_start_week", "longest_win_streak_end_season", "longest_win_streak_end_week", "longest_loss_streak", "longest_loss_streak_start_season", "longest_loss_streak_start_week", "longest_loss_streak_end_season", "longest_loss_streak_end_week", "current_elo", "peak_elo", "luck_total", "expected_wins", "efficiency_avg" FROM `career_stats`;--> statement-breakpoint
DROP TABLE `career_stats`;--> statement-breakpoint
ALTER TABLE `__new_career_stats` RENAME TO `career_stats`;--> statement-breakpoint
CREATE UNIQUE INDEX `career_stats_franchise_id_unique` ON `career_stats` (`franchise_id`);--> statement-breakpoint
CREATE TABLE `__new_elo_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL,
	`season` integer NOT NULL,
	`week` integer NOT NULL,
	`franchise_id` integer NOT NULL,
	`elo_pre` real NOT NULL,
	`elo_post` real NOT NULL,
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_elo_history`("id", "build_id", "season", "week", "franchise_id", "elo_pre", "elo_post") SELECT "id", "build_id", "season", "week", "franchise_id", "elo_pre", "elo_post" FROM `elo_history`;--> statement-breakpoint
DROP TABLE `elo_history`;--> statement-breakpoint
ALTER TABLE `__new_elo_history` RENAME TO `elo_history`;--> statement-breakpoint
CREATE UNIQUE INDEX `elo_history_season_week_franchise_id_unique` ON `elo_history` (`season`,`week`,`franchise_id`);--> statement-breakpoint
CREATE TABLE `__new_franchise_elo` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL,
	`franchise_id` integer NOT NULL,
	`current` real NOT NULL,
	`peak` real NOT NULL,
	`peak_season` integer NOT NULL,
	`peak_week` integer NOT NULL,
	`trough` real NOT NULL,
	`weeks_at_no1` integer NOT NULL,
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_franchise_elo`("id", "build_id", "franchise_id", "current", "peak", "peak_season", "peak_week", "trough", "weeks_at_no1") SELECT "id", "build_id", "franchise_id", "current", "peak", "peak_season", "peak_week", "trough", "weeks_at_no1" FROM `franchise_elo`;--> statement-breakpoint
DROP TABLE `franchise_elo`;--> statement-breakpoint
ALTER TABLE `__new_franchise_elo` RENAME TO `franchise_elo`;--> statement-breakpoint
CREATE UNIQUE INDEX `franchise_elo_franchise_id_unique` ON `franchise_elo` (`franchise_id`);--> statement-breakpoint
CREATE TABLE `__new_h2h_pairs` (
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
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_h2h_pairs`("id", "build_id", "franchise_a", "franchise_b", "reg_w", "reg_l", "reg_t", "playoff_w", "playoff_l", "playoff_t", "points_a", "points_b", "avg_margin", "streak_holder", "streak_len", "largest_win_json", "closest_game_json", "last_meeting_json") SELECT "id", "build_id", "franchise_a", "franchise_b", "reg_w", "reg_l", "reg_t", "playoff_w", "playoff_l", "playoff_t", "points_a", "points_b", "avg_margin", "streak_holder", "streak_len", "largest_win_json", "closest_game_json", "last_meeting_json" FROM `h2h_pairs`;--> statement-breakpoint
DROP TABLE `h2h_pairs`;--> statement-breakpoint
ALTER TABLE `__new_h2h_pairs` RENAME TO `h2h_pairs`;--> statement-breakpoint
CREATE UNIQUE INDEX `h2h_pairs_franchise_a_franchise_b_unique` ON `h2h_pairs` (`franchise_a`,`franchise_b`);--> statement-breakpoint
CREATE TABLE `__new_record_entries` (
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
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_record_entries`("id", "build_id", "record_key", "rank", "franchise_id", "season", "week", "value", "week_type", "detail_json") SELECT "id", "build_id", "record_key", "rank", "franchise_id", "season", "week", "value", "week_type", "detail_json" FROM `record_entries`;--> statement-breakpoint
DROP TABLE `record_entries`;--> statement-breakpoint
ALTER TABLE `__new_record_entries` RENAME TO `record_entries`;--> statement-breakpoint
CREATE UNIQUE INDEX `record_entries_record_key_rank_franchise_id_season_week_unique` ON `record_entries` (`record_key`,`rank`,`franchise_id`,`season`,`week`);--> statement-breakpoint
CREATE TABLE `__new_season_stats` (
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
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_season_stats`("id", "build_id", "season", "franchise_id", "wins", "losses", "ties", "points_for", "points_against", "allplay_w", "allplay_l", "allplay_t", "luck_total", "expected_wins", "efficiency_avg", "final_standing", "made_playoffs", "champion", "sacko") SELECT "id", "build_id", "season", "franchise_id", "wins", "losses", "ties", "points_for", "points_against", "allplay_w", "allplay_l", "allplay_t", "luck_total", "expected_wins", "efficiency_avg", "final_standing", "made_playoffs", "champion", "sacko" FROM `season_stats`;--> statement-breakpoint
DROP TABLE `season_stats`;--> statement-breakpoint
ALTER TABLE `__new_season_stats` RENAME TO `season_stats`;--> statement-breakpoint
CREATE UNIQUE INDEX `season_stats_season_franchise_id_unique` ON `season_stats` (`season`,`franchise_id`);--> statement-breakpoint
CREATE TABLE `__new_team_week` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL,
	`season` integer NOT NULL,
	`week` integer NOT NULL,
	`week_type` text NOT NULL,
	`team_season_id` integer NOT NULL,
	`franchise_id` integer NOT NULL,
	`opponent_franchise_id` integer,
	`matchup_id` integer,
	`score` real NOT NULL,
	`projected` real,
	`result` text,
	`margin` real,
	`optimal_score` real,
	`bench_points_left` real,
	`efficiency` real,
	`eligibility_fallback` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_team_week`("id", "build_id", "season", "week", "week_type", "team_season_id", "franchise_id", "opponent_franchise_id", "matchup_id", "score", "projected", "result", "margin", "optimal_score", "bench_points_left", "efficiency", "eligibility_fallback") SELECT "id", "build_id", "season", "week", "week_type", "team_season_id", "franchise_id", "opponent_franchise_id", "matchup_id", "score", "projected", "result", "margin", "optimal_score", "bench_points_left", "efficiency", "eligibility_fallback" FROM `team_week`;--> statement-breakpoint
DROP TABLE `team_week`;--> statement-breakpoint
ALTER TABLE `__new_team_week` RENAME TO `team_week`;--> statement-breakpoint
CREATE INDEX `team_week_franchise_id_season_idx` ON `team_week` (`franchise_id`,`season`);--> statement-breakpoint
CREATE UNIQUE INDEX `team_week_season_week_franchise_id_unique` ON `team_week` (`season`,`week`,`franchise_id`);