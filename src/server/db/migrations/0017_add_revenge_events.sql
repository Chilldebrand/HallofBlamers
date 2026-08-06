CREATE TABLE `revenge_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL,
	`franchise_id` integer NOT NULL,
	`player_id` integer NOT NULL,
	`departure_type` text NOT NULL,
	`departure_transaction_id` integer NOT NULL,
	`departure_espn_tx_id` text NOT NULL,
	`current_franchise_id` integer NOT NULL,
	`current_team_season_id` integer NOT NULL,
	`matchup_id` integer NOT NULL,
	`season` integer NOT NULL,
	`week` integer NOT NULL,
	`points` real NOT NULL,
	`is_against_former_franchise` integer NOT NULL,
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`espn_player_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `revenge_events_franchise_id_idx` ON `revenge_events` (`franchise_id`);--> statement-breakpoint
CREATE INDEX `revenge_events_franchise_id_player_id_idx` ON `revenge_events` (`franchise_id`,`player_id`);--> statement-breakpoint
CREATE INDEX `revenge_events_franchise_id_against_idx` ON `revenge_events` (`franchise_id`,`is_against_former_franchise`);--> statement-breakpoint
CREATE UNIQUE INDEX `revenge_events_franchise_id_player_id_season_week_unique` ON `revenge_events` (`franchise_id`,`player_id`,`season`,`week`);
