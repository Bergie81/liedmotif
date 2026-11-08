CREATE TYPE "public"."playlist_share_audience" AS ENUM('everyone', 'selected');--> statement-breakpoint
CREATE TABLE "playlist_share_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playlist_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "playlists" ADD COLUMN "share_audience" "playlist_share_audience" DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "playlist_share_members" ADD CONSTRAINT "playlist_share_members_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_share_members" ADD CONSTRAINT "playlist_share_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "playlist_share_members_playlist_user_unique" ON "playlist_share_members" USING btree ("playlist_id","user_id");--> statement-breakpoint
CREATE INDEX "playlist_share_members_user_id_idx" ON "playlist_share_members" USING btree ("user_id");