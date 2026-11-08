CREATE TYPE "public"."playlist_kind" AS ENUM('user', 'favorites');--> statement-breakpoint
CREATE TABLE "playlist_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playlist_id" uuid NOT NULL,
	"track_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" "playlist_kind" DEFAULT 'user' NOT NULL,
	"cover_image_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "playlist_tracks" ADD CONSTRAINT "playlist_tracks_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_tracks" ADD CONSTRAINT "playlist_tracks_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_cover_image_id_cover_images_id_fk" FOREIGN KEY ("cover_image_id") REFERENCES "public"."cover_images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playlist_tracks_playlist_id_idx" ON "playlist_tracks" USING btree ("playlist_id");--> statement-breakpoint
CREATE INDEX "playlist_tracks_track_id_idx" ON "playlist_tracks" USING btree ("track_id");--> statement-breakpoint
CREATE UNIQUE INDEX "playlist_tracks_playlist_track_unique" ON "playlist_tracks" USING btree ("playlist_id","track_id");--> statement-breakpoint
CREATE INDEX "playlists_owner_user_id_idx" ON "playlists" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "playlists_owner_favorites_unique" ON "playlists" USING btree ("owner_user_id") WHERE "playlists"."kind" = 'favorites';--> statement-breakpoint
-- Retention-is-membership backfill: existing favorited tracks become the owner's
-- Favorites system playlist (ordered by favorited_at); saved-but-unfiled tracks
-- are seeded into a one-time ordinary "Saved tracks" playlist so no track
-- silently loses Durable status. Rejected/deleted rows drop stale flags so the
-- membership <=> flags invariant starts true.
INSERT INTO "playlists" ("owner_user_id", "name", "kind")
SELECT DISTINCT t."owner_user_id", 'Favorites', 'favorites'::"playlist_kind"
FROM "tracks" t
WHERE t."favorited_at" IS NOT NULL AND t."status" NOT IN ('rejected', 'deleted');--> statement-breakpoint
INSERT INTO "playlist_tracks" ("playlist_id", "track_id", "position")
SELECT p."id", t."id",
  (ROW_NUMBER() OVER (PARTITION BY t."owner_user_id" ORDER BY t."favorited_at", t."id")) - 1
FROM "tracks" t
JOIN "playlists" p ON p."owner_user_id" = t."owner_user_id" AND p."kind" = 'favorites'
WHERE t."favorited_at" IS NOT NULL AND t."status" NOT IN ('rejected', 'deleted');--> statement-breakpoint
INSERT INTO "playlists" ("owner_user_id", "name", "kind")
SELECT DISTINCT t."owner_user_id", 'Saved tracks', 'user'::"playlist_kind"
FROM "tracks" t
WHERE t."saved_at" IS NOT NULL AND t."favorited_at" IS NULL
  AND t."status" NOT IN ('rejected', 'deleted');--> statement-breakpoint
INSERT INTO "playlist_tracks" ("playlist_id", "track_id", "position")
SELECT p."id", t."id",
  (ROW_NUMBER() OVER (PARTITION BY t."owner_user_id" ORDER BY t."saved_at", t."id")) - 1
FROM "tracks" t
JOIN "playlists" p
  ON p."owner_user_id" = t."owner_user_id" AND p."kind" = 'user' AND p."name" = 'Saved tracks'
WHERE t."saved_at" IS NOT NULL AND t."favorited_at" IS NULL
  AND t."status" NOT IN ('rejected', 'deleted');--> statement-breakpoint
UPDATE "tracks" SET "saved_at" = NULL, "favorited_at" = NULL
WHERE ("saved_at" IS NOT NULL OR "favorited_at" IS NOT NULL)
  AND "status" IN ('rejected', 'deleted');
