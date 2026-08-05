ALTER TABLE `career_stats` ADD `beatdowns` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `career_stats` ADD `worst_beatdown_margin` real;--> statement-breakpoint
ALTER TABLE `career_stats` ADD `worst_beatdown_season` integer;--> statement-breakpoint
ALTER TABLE `career_stats` ADD `worst_beatdown_week` integer;--> statement-breakpoint
ALTER TABLE `season_stats` ADD `beatdowns` integer DEFAULT 0 NOT NULL;