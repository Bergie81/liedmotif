CREATE TABLE "listening_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"analytics_track_id" uuid NOT NULL,
	"track_id" uuid,
	"session_id" uuid,
	"surface" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_listened_at" timestamp with time zone NOT NULL,
	"listened_ms" integer DEFAULT 0 NOT NULL,
	"time_buckets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"qualified_at" timestamp with time zone,
	"end_reason" text,
	"genre_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"energy" text,
	"vocal_mode" "vocal_mode",
	"bpm_estimate" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listening_preferences" (
	"owner_user_id" text PRIMARY KEY NOT NULL,
	"reporting_timezone" text,
	"collection_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "analytics_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "listening_occurrences" ADD CONSTRAINT "listening_occurrences_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listening_occurrences" ADD CONSTRAINT "listening_occurrences_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listening_occurrences" ADD CONSTRAINT "listening_occurrences_session_id_activity_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."activity_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listening_preferences" ADD CONSTRAINT "listening_preferences_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "listening_occurrences_owner_occurrence_unique" ON "listening_occurrences" USING btree ("owner_user_id","occurrence_id");--> statement-breakpoint
CREATE INDEX "listening_occurrences_owner_last_listened_idx" ON "listening_occurrences" USING btree ("owner_user_id","last_listened_at");--> statement-breakpoint
-- Collection begins for every existing account the moment this migration runs.
-- An account with no row was created afterwards, and is covered from its creation.
INSERT INTO "listening_preferences" ("owner_user_id") SELECT "id" FROM "user" ON CONFLICT DO NOTHING;
