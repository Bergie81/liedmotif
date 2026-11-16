-- Cover-art preferences are each User's own. Until now one instance-wide value
-- existed, and only the Admin could write it, so it becomes the Admin's: a
-- Member keeps the shipped defaults. The instance row goes so nothing can read
-- it as a fallback.
INSERT INTO "user_settings" ("owner_user_id", "key", "value")
SELECT "user_profiles"."user_id", 'coverArt', "app_settings"."value"
FROM "app_settings"
JOIN "user_profiles" ON "user_profiles"."role" = 'admin'
WHERE "app_settings"."key" = 'coverArt'
ON CONFLICT ("owner_user_id", "key") DO NOTHING;--> statement-breakpoint
DELETE FROM "app_settings" WHERE "key" = 'coverArt';
