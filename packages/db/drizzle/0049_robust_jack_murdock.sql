ALTER TABLE "playlists" ADD COLUMN IF NOT EXISTS "listed_in_playlists" boolean DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE "playlists"
SET "listed_in_playlists" = false
WHERE "kind" = 'favorites'
   OR ("kind" = 'user' AND "name" = 'Saved tracks');
