CREATE TABLE `allplay_week` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL,
	`season` integer NOT NULL,
	`week` integer NOT NULL,
	`franchise_id` integer NOT NULL,
	`wins` integer NOT NULL,
	`losses` integer NOT NULL,
	`ties` integer NOT NULL,
	`luck_score` real,
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`franchise_id`) REFERENCES `franchises`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `allplay_week_season_week_franchise_id_unique` ON `allplay_week` (`season`,`week`,`franchise_id`);--> statement-breakpoint
CREATE TABLE `team_week` (
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
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_season_id`) REFERENCES `team_seasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`franchise_id`) REFERENCES `franchises`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`opponent_franchise_id`) REFERENCES `franchises`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`matchup_id`) REFERENCES `matchups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `team_week_franchise_id_season_idx` ON `team_week` (`franchise_id`,`season`);--> statement-breakpoint
CREATE UNIQUE INDEX `team_week_season_week_franchise_id_unique` ON `team_week` (`season`,`week`,`franchise_id`);