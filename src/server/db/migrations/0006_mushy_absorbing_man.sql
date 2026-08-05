CREATE TABLE `poll_options` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`poll_id` integer NOT NULL,
	`label` text NOT NULL,
	`sort` integer NOT NULL,
	`is_write_in` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`poll_id`) REFERENCES `polls`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `poll_options_poll_id_idx` ON `poll_options` (`poll_id`);--> statement-breakpoint
CREATE TABLE `poll_votes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`poll_id` integer NOT NULL,
	`option_id` integer NOT NULL,
	`manager_id` integer NOT NULL,
	`voted_at` integer NOT NULL,
	FOREIGN KEY (`poll_id`) REFERENCES `polls`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`option_id`) REFERENCES `poll_options`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`manager_id`) REFERENCES `managers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `poll_votes_poll_id_manager_id_idx` ON `poll_votes` (`poll_id`,`manager_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `poll_votes_poll_id_option_id_manager_id_unique` ON `poll_votes` (`poll_id`,`option_id`,`manager_id`);--> statement-breakpoint
CREATE TABLE `polls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`question` text NOT NULL,
	`description` text,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`anonymous` integer DEFAULT false NOT NULL,
	`allow_write_in` integer DEFAULT false NOT NULL,
	`created_by` integer NOT NULL,
	`created_at` integer NOT NULL,
	`opens_at` integer,
	`closes_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `managers`(`id`) ON UPDATE no action ON DELETE no action
);
