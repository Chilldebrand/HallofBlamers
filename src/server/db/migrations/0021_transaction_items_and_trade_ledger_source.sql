ALTER TABLE `trade_ledger` ADD `source` text DEFAULT 'espn' NOT NULL;--> statement-breakpoint
ALTER TABLE `transaction_items` ADD `source` text DEFAULT 'espn' NOT NULL;
