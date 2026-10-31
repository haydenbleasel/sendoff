CREATE TABLE `events` (
	`at` integer NOT NULL,
	`detail` text,
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text,
	`message_id` text,
	`subscriber_id` text,
	`type` text NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `events_issue_type_idx` ON `events` (`issue_id`,`type`);--> statement-breakpoint
CREATE INDEX `events_message_id_idx` ON `events` (`message_id`);--> statement-breakpoint
CREATE TABLE `issues` (
	`body` text DEFAULT '' NOT NULL,
	`cancelled_at` integer,
	`content_hash` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`preheader` text,
	`rendered_html` text,
	`rendered_text` text,
	`sent_at` integer,
	`slug` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`test_sent_hash` text,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issues_slug_unique` ON `issues` (`slug`);--> statement-breakpoint
CREATE TABLE `sends` (
	`error` text,
	`issue_id` text NOT NULL,
	`message_id` text,
	`sent_at` integer,
	`status` text DEFAULT 'queued' NOT NULL,
	`subscriber_id` text NOT NULL,
	PRIMARY KEY(`issue_id`, `subscriber_id`),
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sends_issue_status_idx` ON `sends` (`issue_id`,`status`);--> statement-breakpoint
CREATE INDEX `sends_message_id_idx` ON `sends` (`message_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`data` text NOT NULL,
	`id` integer PRIMARY KEY NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "settings_single_row" CHECK("settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `subscribers` (
	`confirmed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`email` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`last_engaged_at` integer,
	`metadata` text,
	`name` text,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`unsubscribed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscribers_email_unique` ON `subscribers` (`email`);--> statement-breakpoint
CREATE INDEX `subscribers_status_idx` ON `subscribers` (`status`);