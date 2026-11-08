CREATE TYPE "public"."cover_art_studio_batch_state" AS ENUM('queued', 'running', 'complete', 'partial_failure', 'failed');--> statement-breakpoint
CREATE TYPE "public"."cover_art_studio_candidate_state" AS ENUM('reserved', 'planned', 'submitting', 'finishing', 'ready', 'not_started', 'submission_unknown', 'quality_rejected', 'storage_rejected');--> statement-breakpoint
CREATE TABLE "cover_art_studio_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"client_request_id" uuid NOT NULL,
	"effective_music_prompt" text NOT NULL,
	"session_name" text NOT NULL,
	"style_snapshot" jsonb NOT NULL,
	"custom_style_definition" text,
	"provider_key" text NOT NULL,
	"model" text NOT NULL,
	"requested_styles" jsonb NOT NULL,
	"state" "cover_art_studio_batch_state" DEFAULT 'queued' NOT NULL,
	"candidate_count" integer NOT NULL,
	"reported_cost_usd" double precision,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cover_art_studio_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"batch_id" uuid NOT NULL,
	"requested_style" "cover_style" NOT NULL,
	"resolved_style" "cover_style",
	"plan" jsonb,
	"plan_version" text,
	"prompt_version" text,
	"plan_hash" text,
	"prompt_hash" text,
	"fingerprint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_key" text NOT NULL,
	"model" text NOT NULL,
	"capability_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"capability_downgrades" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"seed" text,
	"state" "cover_art_studio_candidate_state" DEFAULT 'reserved' NOT NULL,
	"possibly_paid" boolean DEFAULT false NOT NULL,
	"submission_disposition" text DEFAULT 'not_started' NOT NULL,
	"safe_retry_count" integer DEFAULT 0 NOT NULL,
	"max_safe_retries" integer DEFAULT 1 NOT NULL,
	"failure_category" text,
	"provider_operation_id" text,
	"reported_cost_usd" double precision,
	"storage_key" text NOT NULL,
	"local_poster_lettering" boolean DEFAULT false NOT NULL,
	"submitted_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cover_art_studio_batches" ADD CONSTRAINT "cover_art_studio_batches_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cover_art_studio_candidates" ADD CONSTRAINT "cover_art_studio_candidates_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cover_art_studio_candidates" ADD CONSTRAINT "cover_art_studio_candidates_batch_id_cover_art_studio_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."cover_art_studio_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cover_art_studio_batches_owner_request_unique" ON "cover_art_studio_batches" USING btree ("owner_user_id","client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cover_art_studio_batches_one_live_per_owner" ON "cover_art_studio_batches" USING btree ("owner_user_id") WHERE "cover_art_studio_batches"."state" in ('queued', 'running') and "cover_art_studio_batches"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "cover_art_studio_batches_owner_created_idx" ON "cover_art_studio_batches" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cover_art_studio_candidates_batch_style_unique" ON "cover_art_studio_candidates" USING btree ("batch_id","requested_style");--> statement-breakpoint
CREATE UNIQUE INDEX "cover_art_studio_candidates_idempotency_unique" ON "cover_art_studio_candidates" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "cover_art_studio_candidates_storage_key_unique" ON "cover_art_studio_candidates" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "cover_art_studio_candidates_owner_state_idx" ON "cover_art_studio_candidates" USING btree ("owner_user_id","state");