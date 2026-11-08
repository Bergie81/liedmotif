CREATE TABLE "taste_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"analytics_track_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"genre_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"energy" text,
	"vocal_mode" "vocal_mode",
	"bpm_estimate" double precision,
	"language" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listening_occurrences" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "listening_occurrences" ADD COLUMN "taste_eligible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "listening_preferences" ADD COLUMN "personalize_suggestions" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "listening_preferences" ADD COLUMN "taste_reset_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "listening_preferences" ADD COLUMN "taste_seeded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "taste_evidence" ADD CONSTRAINT "taste_evidence_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "taste_evidence_owner_analytics_track_unique" ON "taste_evidence" USING btree ("owner_user_id","analytics_track_id");--> statement-breakpoint
-- The generated-output genre ranking this cache held is replaced by learned taste.
DELETE FROM "user_settings" WHERE "key" = 'topGenres';
