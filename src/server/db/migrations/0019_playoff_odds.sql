CREATE TABLE `playoff_odds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL,
	`season` integer NOT NULL,
	`franchise_id` integer NOT NULL,
	`playoff_probability` real NOT NULL,
	`top_seed_probability` real NOT NULL,
	`seed_distribution_json` text NOT NULL,
	`runs` integer NOT NULL,
	FOREIGN KEY (`build_id`) REFERENCES `stat_builds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `playoff_odds_franchise_id_unique` ON `playoff_odds` (`franchise_id`);
