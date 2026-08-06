CREATE TABLE `notification_prefs` (
	`manager_id` integer PRIMARY KEY NOT NULL,
	`lead_changes` integer DEFAULT false NOT NULL,
	`finals` integer DEFAULT true NOT NULL,
	`records` integer DEFAULT true NOT NULL,
	`belt_events` integer DEFAULT true NOT NULL,
	`lineup_holes` integer DEFAULT true NOT NULL,
	`weekly_recap` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`manager_id`) REFERENCES `managers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`manager_id` integer NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`last_delivered_event_id` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`manager_id`) REFERENCES `managers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_manager_id_idx` ON `push_subscriptions` (`manager_id`);
