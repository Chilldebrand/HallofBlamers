ALTER TABLE `managers` ADD `pin_hash` text;--> statement-breakpoint
ALTER TABLE `managers` ADD `pin_failed_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `managers` ADD `pin_lockout_level` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `managers` ADD `pin_locked_until` integer;
