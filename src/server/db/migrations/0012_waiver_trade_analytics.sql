CREATE TABLE `trade_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL,
	`season` integer NOT NULL,
	`transaction_id` integer NOT NULL,
	`espn_tx_id` text NOT NULL,
	`trade_week` integer NOT NULL,
	`receiving_franchise_id` integer NOT NULL,
	`receiving_team_season_id` integer NOT NULL,
	`sending_franchise_id` integer NOT NULL,
	`sending_team_season_id` integer NOT NULL,
	`player_id` integer NOT NULL,
	`weeks_rostered` integer NOT NULL,
	`starts_made` integer NOT NULL,
	`starter_points` real NOT NULL,
	`points_per_start` real,
	`still_rostered` integer NOT NULL,
	`dropped_week` integer,
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`espn_player_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `trade_ledger_season_idx` ON `trade_ledger` (`season`);--> statement-breakpoint
CREATE INDEX `trade_ledger_transaction_id_idx` ON `trade_ledger` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `trade_ledger_receiving_franchise_id_idx` ON `trade_ledger` (`receiving_franchise_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `trade_ledger_transaction_id_receiving_team_season_id_player_id_unique` ON `trade_ledger` (`transaction_id`,`receiving_team_season_id`,`player_id`);--> statement-breakpoint
CREATE TABLE `waiver_acquisitions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL,
	`season` integer NOT NULL,
	`franchise_id` integer NOT NULL,
	`team_season_id` integer NOT NULL,
	`player_id` integer NOT NULL,
	`type` text NOT NULL,
	`bid_amount` real,
	`transaction_id` integer NOT NULL,
	`espn_tx_id` text NOT NULL,
	`acquired_week` integer NOT NULL,
	`dropped_week` integer,
	`still_rostered` integer NOT NULL,
	`weeks_rostered` integer NOT NULL,
	`starts_made` integer NOT NULL,
	`starter_points` real NOT NULL,
	`points_per_start` real,
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`espn_player_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `waiver_acquisitions_season_franchise_id_idx` ON `waiver_acquisitions` (`season`,`franchise_id`);--> statement-breakpoint
CREATE INDEX `waiver_acquisitions_franchise_id_idx` ON `waiver_acquisitions` (`franchise_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `waiver_acquisitions_transaction_id_team_season_id_player_id_unique` ON `waiver_acquisitions` (`transaction_id`,`team_season_id`,`player_id`);
