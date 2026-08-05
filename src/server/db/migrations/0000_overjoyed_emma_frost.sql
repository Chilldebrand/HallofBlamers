CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `corrections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`target_table` text NOT NULL,
	`target_key_json` text NOT NULL,
	`field` text NOT NULL,
	`value_json` text NOT NULL,
	`reason` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `draft_picks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season` integer NOT NULL,
	`round` integer NOT NULL,
	`round_pick` integer NOT NULL,
	`overall_pick` integer NOT NULL,
	`team_season_id` integer NOT NULL,
	`player_id` integer NOT NULL,
	`keeper` integer DEFAULT false NOT NULL,
	`auction_amount` real,
	FOREIGN KEY (`team_season_id`) REFERENCES `team_seasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`espn_player_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `draft_picks_season_overall_pick_unique` ON `draft_picks` (`season`,`overall_pick`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_type` text NOT NULL,
	`season` integer,
	`week` integer,
	`occurred_at` integer NOT NULL,
	`detected_at` integer NOT NULL,
	`franchise_id` integer,
	`matchup_id` integer,
	`player_id` integer,
	`payload_json` text NOT NULL,
	`dedupe_key` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_dedupe_key_unique` ON `events` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `events_event_type_idx` ON `events` (`event_type`);--> statement-breakpoint
CREATE INDEX `events_season_week_idx` ON `events` (`season`,`week`);--> statement-breakpoint
CREATE TABLE `franchise_managers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`franchise_id` integer NOT NULL,
	`manager_name` text NOT NULL,
	`espn_owner_swid` text,
	`from_season` integer NOT NULL,
	`to_season` integer,
	FOREIGN KEY (`franchise_id`) REFERENCES `franchises`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `franchises` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`canonical_name` text NOT NULL,
	`manager_name` text NOT NULL,
	`joined_season` integer NOT NULL,
	`departed_season` integer,
	`active` integer DEFAULT true NOT NULL,
	`accent_color` text,
	`notes` text
);
--> statement-breakpoint
CREATE TABLE `leagues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`espn_league_id` integer NOT NULL,
	`name` text NOT NULL,
	`first_season` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leagues_espn_league_id_unique` ON `leagues` (`espn_league_id`);--> statement-breakpoint
CREATE TABLE `managers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`franchise_id` integer,
	`role` text NOT NULL,
	`invite_token` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`franchise_id`) REFERENCES `franchises`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `managers_invite_token_unique` ON `managers` (`invite_token`);--> statement-breakpoint
CREATE TABLE `matchups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season` integer NOT NULL,
	`week` integer NOT NULL,
	`espn_matchup_id` integer NOT NULL,
	`home_team_season_id` integer NOT NULL,
	`away_team_season_id` integer,
	`home_score` real NOT NULL,
	`away_score` real NOT NULL,
	`home_projected` real,
	`away_projected` real,
	`playoff_tier` text,
	`multi_week_group` text,
	`is_final` integer NOT NULL,
	`winner` text,
	FOREIGN KEY (`home_team_season_id`) REFERENCES `team_seasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`away_team_season_id`) REFERENCES `team_seasons`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `matchups_season_week_espn_matchup_id_unique` ON `matchups` (`season`,`week`,`espn_matchup_id`);--> statement-breakpoint
CREATE TABLE `players` (
	`espn_player_id` integer PRIMARY KEY NOT NULL,
	`full_name` text NOT NULL,
	`default_position` text NOT NULL,
	`pro_team` text,
	`headshot_url` text
);
--> statement-breakpoint
CREATE TABLE `recaps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season` integer NOT NULL,
	`week` integer NOT NULL,
	`style` text NOT NULL,
	`status` text NOT NULL,
	`facts_json` text NOT NULL,
	`prompt_version` text,
	`model` text,
	`markdown_draft` text,
	`markdown_final` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`cost_usd` real,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recaps_season_week_idx` ON `recaps` (`season`,`week`);--> statement-breakpoint
CREATE TABLE `roster_slots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season` integer NOT NULL,
	`week` integer NOT NULL,
	`team_season_id` integer NOT NULL,
	`player_id` integer NOT NULL,
	`lineup_slot` text NOT NULL,
	`is_starter` integer NOT NULL,
	`points` real,
	`projected_points` real,
	`eligible_slots_json` text NOT NULL,
	FOREIGN KEY (`team_season_id`) REFERENCES `team_seasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`espn_player_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roster_slots_season_week_team_season_id_player_id_unique` ON `roster_slots` (`season`,`week`,`team_season_id`,`player_id`);--> statement-breakpoint
CREATE TABLE `seasons` (
	`season` integer PRIMARY KEY NOT NULL,
	`league_id` integer NOT NULL,
	`settings_json` text NOT NULL,
	`scoring_json` text NOT NULL,
	`playoff_format_json` text NOT NULL,
	`team_count` integer NOT NULL,
	`reg_season_weeks` integer NOT NULL,
	`status` text NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season` integer NOT NULL,
	`scoring_period` integer,
	`view` text NOT NULL,
	`url` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`http_status` integer NOT NULL,
	`payload` text NOT NULL,
	`payload_hash` text NOT NULL,
	`superseded` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `snapshots_season_view_period_fetched_idx` ON `snapshots` (`season`,`view`,`scoring_period`,"fetched_at" desc);--> statement-breakpoint
CREATE INDEX `snapshots_payload_hash_idx` ON `snapshots` (`payload_hash`);--> statement-breakpoint
CREATE TABLE `stat_builds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`input_hash` text NOT NULL,
	`status` text NOT NULL,
	`duration_ms` integer,
	`error_text` text
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`tier` text NOT NULL,
	`status` text NOT NULL,
	`views_fetched` integer DEFAULT 0 NOT NULL,
	`snapshots_new` integer DEFAULT 0 NOT NULL,
	`events_emitted` integer DEFAULT 0 NOT NULL,
	`error_text` text
);
--> statement-breakpoint
CREATE TABLE `team_seasons` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season` integer NOT NULL,
	`franchise_id` integer NOT NULL,
	`espn_team_id` integer NOT NULL,
	`team_name` text NOT NULL,
	`abbrev` text,
	`logo_url` text,
	`division_id` integer,
	`wins` integer NOT NULL,
	`losses` integer NOT NULL,
	`ties` integer NOT NULL,
	`points_for` real NOT NULL,
	`points_against` real NOT NULL,
	`final_standing` integer,
	`made_playoffs` integer NOT NULL,
	FOREIGN KEY (`season`) REFERENCES `seasons`(`season`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`franchise_id`) REFERENCES `franchises`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_seasons_season_espn_team_id_unique` ON `team_seasons` (`season`,`espn_team_id`);--> statement-breakpoint
CREATE TABLE `transaction_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transaction_id` integer NOT NULL,
	`team_season_id` integer NOT NULL,
	`player_id` integer NOT NULL,
	`action` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_season_id`) REFERENCES `team_seasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`espn_player_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season` integer NOT NULL,
	`espn_tx_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`bid_amount` real,
	`proposed_at` integer,
	`processed_at` integer,
	`raw_json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_season_espn_tx_id_unique` ON `transactions` (`season`,`espn_tx_id`);--> statement-breakpoint
CREATE TABLE `weeks` (
	`season` integer NOT NULL,
	`week` integer NOT NULL,
	`scoring_period_id` integer NOT NULL,
	`week_type` text NOT NULL,
	`is_complete` integer NOT NULL,
	PRIMARY KEY(`season`, `week`)
);
