-- Cover-art preferences are each User's own. The instance coverArt row moves to
-- the Admin, the only User who could write it; Members start on the shipped
-- defaults; the instance row is removed so nothing falls back to it.
INSERT INTO "user_settings" ("owner_user_id", "key", "value")
SELECT "user_profiles"."user_id", 'coverArt', "app_settings"."value"
FROM "app_settings"
JOIN "user_profiles" ON "user_profiles"."role" = 'admin'
WHERE "app_settings"."key" = 'coverArt'
ON CONFLICT ("owner_user_id", "key") DO NOTHING;--> statement-breakpoint
DELETE FROM "app_settings" WHERE "key" = 'coverArt';
