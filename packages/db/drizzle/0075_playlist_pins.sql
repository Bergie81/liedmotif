CREATE TABLE "playlist_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visitor_user_id" text NOT NULL,
	"playlist_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "playlist_pins" ADD CONSTRAINT "playlist_pins_visitor_user_id_user_id_fk" FOREIGN KEY ("visitor_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_pins" ADD CONSTRAINT "playlist_pins_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "playlist_pins_visitor_playlist_unique" ON "playlist_pins" USING btree ("visitor_user_id","playlist_id");--> statement-breakpoint
CREATE INDEX "playlist_pins_playlist_id_idx" ON "playlist_pins" USING btree ("playlist_id");