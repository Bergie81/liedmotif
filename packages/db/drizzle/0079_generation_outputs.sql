CREATE TABLE "generation_outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"analytics_track_id" uuid NOT NULL,
	"track_id" uuid,
	"first_playable_at" timestamp with time zone DEFAULT now() NOT NULL,
	"storage_failed_at" timestamp with time zone,
	"historical" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "generation_outputs" ADD CONSTRAINT "generation_outputs_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_outputs" ADD CONSTRAINT "generation_outputs_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "generation_outputs_analytics_track_unique" ON "generation_outputs" USING btree ("analytics_track_id");--> statement-breakpoint
CREATE INDEX "generation_outputs_owner_first_playable_idx" ON "generation_outputs" USING btree ("owner_user_id","first_playable_at");--> statement-breakpoint
CREATE INDEX "generation_outputs_track_id_idx" ON "generation_outputs" USING btree ("track_id");--> statement-breakpoint
CREATE INDEX "listening_occurrences_owner_analytics_track_idx" ON "listening_occurrences" USING btree ("owner_user_id","analytics_track_id");--> statement-breakpoint
-- The only substantiated history: Tracks that still exist and once played were
-- produced. Tracks deleted before this ledger left no trace, so these rows are
-- marked `historical` — an incomplete count, never a lifetime total.
INSERT INTO "generation_outputs" ("owner_user_id", "analytics_track_id", "track_id", "first_playable_at", "historical")
SELECT "owner_user_id", "analytics_id", "id", "created_at", true
FROM "tracks"
WHERE "status" IN ('streamable', 'ready', 'rejected', 'deleted')
ON CONFLICT DO NOTHING;
