ALTER TABLE `issues` ADD `recipient_count` integer;--> statement-breakpoint
ALTER TABLE `issues` ADD `send_error` text;--> statement-breakpoint
ALTER TABLE `issues` ADD `send_heartbeat_at` integer;--> statement-breakpoint
ALTER TABLE `issues` ADD `send_started_at` integer;--> statement-breakpoint
ALTER TABLE `issues` ADD `sender` text;--> statement-breakpoint
ALTER TABLE `issues` ADD `test_sent_at` integer;