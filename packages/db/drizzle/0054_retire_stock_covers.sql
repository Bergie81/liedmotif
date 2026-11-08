-- The bundled stock-cover library is retired: sessions now keep the built-in
-- branded placeholder until a generated cover (image model, else the music
-- provider's own art) lands. Repoint anything wearing a stock cover, then drop
-- the stock rows. The placeholder row is (re)inserted first under its stable
-- derived id so the repoint never dangles; its storage bytes are self-healed by
-- the covers route on first serve. The `cover_source_type` enum keeps its
-- legacy `stock` value (Postgres cannot drop an enum value in place); it is
-- simply never written again.
INSERT INTO "cover_images" ("id", "source_type", "storage_provider", "storage_key", "tags")
VALUES (
  '8740f2eb-48d1-57ca-bb0c-ad69b940810e',
  'placeholder',
  'local',
  'covers/placeholder.webp',
  '{"label":"Liedmotif"}'::jsonb
)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
UPDATE "activity_sessions"
SET "cover_image_id" = '8740f2eb-48d1-57ca-bb0c-ad69b940810e'
WHERE "cover_image_id" IN (SELECT "id" FROM "cover_images" WHERE "source_type" = 'stock');
--> statement-breakpoint
UPDATE "tracks"
SET "cover_image_id" = NULL
WHERE "cover_image_id" IN (SELECT "id" FROM "cover_images" WHERE "source_type" = 'stock');
--> statement-breakpoint
UPDATE "playlists"
SET "cover_image_id" = NULL
WHERE "cover_image_id" IN (SELECT "id" FROM "cover_images" WHERE "source_type" = 'stock');
--> statement-breakpoint
DELETE FROM "cover_images" WHERE "source_type" = 'stock';
