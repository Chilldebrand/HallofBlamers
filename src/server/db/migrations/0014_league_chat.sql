CREATE TABLE `chat_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`manager_id` integer,
	`kind` text DEFAULT 'user' NOT NULL,
	`body` text NOT NULL,
	`dedupe_key` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`manager_id`) REFERENCES `managers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chat_messages_kind_manager_id_check" CHECK((kind = 'user' AND manager_id IS NOT NULL) OR (kind = 'system' AND manager_id IS NULL)),
	CONSTRAINT "chat_messages_body_length_check" CHECK(length(body) <= 2000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_messages_dedupe_key_unique` ON `chat_messages` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `chat_messages_channel_id_idx` ON `chat_messages` (`channel`,`id`);
