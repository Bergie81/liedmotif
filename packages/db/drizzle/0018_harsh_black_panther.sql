CREATE TYPE "public"."session_cover_generation_state" AS ENUM('not_admitted', 'reserved', 'planned', 'submitting', 'storing', 'ready', 'quality_rejected', 'provider_unavailable', 'provider_rejected', 'submission_unknown', 'storage_rejected', 'privacy_rejected');--> statement-breakpoint
ALTER TYPE "public"."cover_style" RENAME TO "cover_style_old";--> statement-breakpoint
CREATE TYPE "public"."cover_style" AS ENUM('auto', 'photographic', 'cinematic', 'minimal', 'abstract', 'drawing', 'collage', 'retro', 'surreal', 'futuristic', 'poster_art', 'custom');--> statement-breakpoint
ALTER TABLE "activity_sessions" ALTER COLUMN "cover_style" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "activity_sessions" ALTER COLUMN "cover_style" TYPE "public"."cover_style" USING "cover_style"::text::"public"."cover_style";--> statement-breakpoint
ALTER TABLE "activity_sessions" ALTER COLUMN "cover_style" SET DEFAULT 'auto';--> statement-breakpoint
DROP TYPE "public"."cover_style_old";--> statement-breakpoint
CREATE TABLE "session_cover_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"activity_session_id" uuid,
	"state" "session_cover_generation_state" NOT NULL,
	"possibly_paid" boolean DEFAULT false NOT NULL,
	"plan" jsonb NOT NULL,
	"plan_version" text NOT NULL,
	"prompt_version" text NOT NULL,
	"plan_hash" text NOT NULL,
	"prompt_hash" text NOT NULL,
	"fingerprint" jsonb NOT NULL,
	"provider_key" text NOT NULL,
	"model" text NOT NULL,
	"capability_snapshot" jsonb NOT NULL,
	"capability_downgrades" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"retry_policy" jsonb NOT NULL,
	"selected_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seed" text,
	"cover_image_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"failure_category" text,
	"cost_usd" double precision,
	"provider_operation_id" text,
	"submission_disposition" text DEFAULT 'not_started' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"submitted_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_sessions" ADD COLUMN "cover_concept" text;--> statement-breakpoint
ALTER TABLE "activity_sessions" ADD COLUMN "cover_style_fallback_reason" text;--> statement-breakpoint
UPDATE "activity_sessions"
SET "cover_style" = 'custom',
    "cover_style_hint_normalized" = btrim("cover_style_hint")
WHERE "cover_style" = 'auto'
  AND btrim(coalesce("cover_style_hint", '')) <> '';--> statement-breakpoint
UPDATE "activity_sessions"
SET "cover_style_hint" = NULL,
    "cover_style_hint_normalized" = NULL
WHERE "cover_style" <> 'custom';--> statement-breakpoint
ALTER TABLE "session_cover_generations" ADD CONSTRAINT "session_cover_generations_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_cover_generations_owner_session_unique" ON "session_cover_generations" USING btree ("owner_user_id","activity_session_id");--> statement-breakpoint
CREATE INDEX "session_cover_generations_owner_created_idx" ON "session_cover_generations" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "session_cover_generations_owner_state_idx" ON "session_cover_generations" USING btree ("owner_user_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "session_cover_generations_cover_id_unique" ON "session_cover_generations" USING btree ("cover_image_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_cover_generations_storage_key_unique" ON "session_cover_generations" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "session_cover_generations_idempotency_key_unique" ON "session_cover_generations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_sessions_owner_id_unique" ON "activity_sessions" USING btree ("owner_user_id","id");--> statement-breakpoint
ALTER TABLE "session_cover_generations" ADD CONSTRAINT "session_cover_generations_owner_session_fk" FOREIGN KEY ("owner_user_id","activity_session_id") REFERENCES "public"."activity_sessions"("owner_user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_sessions" ADD CONSTRAINT "activity_sessions_authoritative_cover_style" CHECK ((
        ("activity_sessions"."cover_style" = 'custom' and btrim(coalesce("activity_sessions"."cover_style_hint", '')) <> '')
        or
        ("activity_sessions"."cover_style" <> 'custom' and "activity_sessions"."cover_style_hint" is null and "activity_sessions"."cover_style_hint_normalized" is null)
      ));
