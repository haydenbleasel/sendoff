CREATE TABLE `api_keys` (
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`hash` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`last_used_at` integer,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`revoked_at` integer,
	`scopes` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_unique` ON `api_keys` (`hash`);