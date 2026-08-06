CREATE TABLE `podcast_episodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season` integer NOT NULL,
	`week` integer NOT NULL,
	`status` text NOT NULL,
	`facts_json` text NOT NULL,
	`prompt_version` text,
	`model` text,
	`segments_draft` text NOT NULL,
	`segments_final` text,
	`segments_generated` text NOT NULL,
	`tokens_in` integer,
	`tokens_out` integer,
	`cost_usd` real,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `podcast_episodes_season_week_idx` ON `podcast_episodes` (`season`,`week`);
