CREATE TYPE "public"."activity_session_status" AS ENUM('active', 'paused', 'stopped', 'completed');--> statement-breakpoint
CREATE TYPE "public"."audio_asset_type" AS ENUM('provider_stream', 'provider_final', 'local_original');--> statement-breakpoint
CREATE TYPE "public"."cover_source_type" AS ENUM('stock', 'generated', 'uploaded', 'unsplash', 'procedural', 'placeholder');--> statement-breakpoint
CREATE TYPE "public"."credential_source" AS ENUM('env', 'database');--> statement-breakpoint
CREATE TYPE "public"."feedback_type" AS ENUM('save', 'unsave', 'favorite', 'unfavorite', 'dislike', 'skip');--> statement-breakpoint
CREATE TYPE "public"."generation_source" AS ENUM('prompt', 'controls', 'more_like_this', 'change_vibe');--> statement-breakpoint
CREATE TYPE "public"."playback_event_type" AS ENUM('started', 'ended', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."provider_normalized_status" AS ENUM('queued', 'submitted', 'submit_unknown', 'processing', 'partially_ready', 'ready', 'failed_retryable', 'failed_final', 'blocked_by_liedmotif_limit', 'blocked_by_provider_credits', 'provider_rate_limited', 'blocked_by_policy');--> statement-breakpoint
CREATE TYPE "public"."provider_submit_state" AS ENUM('not_submitted', 'submitting', 'submitted', 'submit_unknown');--> statement-breakpoint
CREATE TYPE "public"."provider_type" AS ENUM('music', 'llm', 'image', 'storage');--> statement-breakpoint
CREATE TYPE "public"."queue_item_state" AS ENUM('planned', 'generating', 'queued', 'playing', 'played', 'skipped', 'rejected', 'failed');--> statement-breakpoint
CREATE TYPE "public"."session_pause_reason" AS ENUM('user_paused', 'idle_timeout', 'liedmotif_limit', 'provider_credits', 'worker_stalled', 'provider_error');--> statement-breakpoint
CREATE TYPE "public"."track_status" AS ENUM('pending', 'streamable', 'ready', 'rejected', 'deleted', 'failed');--> statement-breakpoint
CREATE TYPE "public"."vocal_mode" AS ENUM('instrumental', 'vocal');--> statement-breakpoint
CREATE TABLE "admin_profile" (
	"user_id" text PRIMARY KEY NOT NULL,
	"role" text DEFAULT 'admin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text,
	"provider_type" "provider_type" NOT NULL,
	"provider_key" text NOT NULL,
	"display_name" text NOT NULL,
	"encrypted_secret" jsonb,
	"config" jsonb,
	"source" "credential_source" NOT NULL,
	"last_validated_at" timestamp with time zone,
	"validation_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider_type" "provider_type" NOT NULL,
	"provider_key" text NOT NULL,
	"operation" text NOT NULL,
	"units" integer NOT NULL,
	"estimated_cost" double precision,
	"provider_credits_before" integer,
	"provider_credits_after" integer,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "taste_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"favorite_genres" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disliked_genres" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preferred_moods" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disliked_moods" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"vocal_preference" text,
	"language_preference" text,
	"energy_preference" jsonb,
	"explicit_content_preference" text,
	"common_activities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"freeform_summary" text,
	"source_summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cover_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" "cover_source_type" NOT NULL,
	"storage_provider" text NOT NULL,
	"storage_key" text NOT NULL,
	"public_path" text,
	"tags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"activity_fit" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mood_fit" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"genre_fit" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"energy_fit" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"color_family" text,
	"visual_theme" text,
	"provenance" jsonb,
	"attribution" jsonb,
	"license_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"activity_session_id" uuid,
	"source" "generation_source" NOT NULL,
	"user_prompt" text,
	"structured_controls" jsonb,
	"expanded_prompt" text,
	"style_prompt" text,
	"title_seed" text,
	"negative_prompt" text,
	"prompt_fingerprint" text,
	"provider_type" "provider_type" NOT NULL,
	"provider_key" text NOT NULL,
	"requested_track_count" integer DEFAULT 2 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"cost_estimate" jsonb,
	"error_code" text,
	"error_message_safe" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generation_request_id" uuid NOT NULL,
	"provider_type" "provider_type" NOT NULL,
	"provider_key" text NOT NULL,
	"provider_task_id" text,
	"submit_state" "provider_submit_state" DEFAULT 'not_submitted' NOT NULL,
	"last_submit_attempt_at" timestamp with time zone,
	"provider_status" text,
	"normalized_status" "provider_normalized_status" DEFAULT 'queued' NOT NULL,
	"raw_request" jsonb,
	"raw_response" jsonb,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_poll_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "track_audio_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_id" uuid NOT NULL,
	"asset_type" "audio_asset_type" NOT NULL,
	"storage_provider" text NOT NULL,
	"storage_key" text,
	"encrypted_source_url" text,
	"mime_type" text,
	"byte_size" bigint,
	"duration_seconds" integer,
	"checksum" text,
	"is_playable" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"generation_request_id" uuid NOT NULL,
	"provider_job_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"provider_track_id" text NOT NULL,
	"title" text,
	"generated_artist_name" text,
	"prompt" text NOT NULL,
	"prompt_fingerprint" text,
	"activity" text,
	"mood" text,
	"genre_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"energy" text,
	"bpm_estimate" integer,
	"vocal_mode" "vocal_mode" DEFAULT 'instrumental' NOT NULL,
	"provider_model" text,
	"generation_parameters" jsonb,
	"license_metadata" jsonb,
	"rights_note" text,
	"cover_image_id" uuid,
	"duration_seconds" integer,
	"status" "track_status" DEFAULT 'pending' NOT NULL,
	"saved_at" timestamp with time zone,
	"favorited_at" timestamp with time zone,
	"disliked_at" timestamp with time zone,
	"deletion_eligible_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_session_queue_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activity_session_id" uuid NOT NULL,
	"track_id" uuid,
	"generation_request_id" uuid,
	"position" integer NOT NULL,
	"state" "queue_item_state" DEFAULT 'planned' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"title" text,
	"user_prompt" text,
	"structured_controls" jsonb,
	"active_taste_profile_snapshot" jsonb,
	"session_style_snapshot" jsonb,
	"status" "activity_session_status" DEFAULT 'active' NOT NULL,
	"pause_reason" "session_pause_reason",
	"status_message_safe" text,
	"target_duration_minutes" integer,
	"buffer_target_tracks" integer DEFAULT 3 NOT NULL,
	"buffer_low_watermark_tracks" integer DEFAULT 2 NOT NULL,
	"current_track_id" uuid,
	"current_queue_item_id" uuid,
	"active_playback_client_id" text,
	"last_playback_position_seconds" double precision,
	"last_playback_report_at" timestamp with time zone,
	"idle_auto_pause_after_minutes" integer DEFAULT 15 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paused_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"track_id" uuid NOT NULL,
	"activity_session_id" uuid,
	"feedback_type" "feedback_type" NOT NULL,
	"feedback_value" text,
	"freeform_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playback_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"activity_session_id" uuid NOT NULL,
	"queue_item_id" uuid,
	"track_id" uuid,
	"event_type" "playback_event_type" NOT NULL,
	"position_seconds" double precision,
	"client_timestamp" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deletion_queue_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"track_id" uuid,
	"storage_key" text,
	"reason" text NOT NULL,
	"delete_after" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"error_message_safe" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_profile" ADD CONSTRAINT "admin_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taste_profiles" ADD CONSTRAINT "taste_profiles_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_requests" ADD CONSTRAINT "generation_requests_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_requests" ADD CONSTRAINT "generation_requests_activity_session_id_activity_sessions_id_fk" FOREIGN KEY ("activity_session_id") REFERENCES "public"."activity_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_jobs" ADD CONSTRAINT "provider_jobs_generation_request_id_generation_requests_id_fk" FOREIGN KEY ("generation_request_id") REFERENCES "public"."generation_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_audio_assets" ADD CONSTRAINT "track_audio_assets_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_generation_request_id_generation_requests_id_fk" FOREIGN KEY ("generation_request_id") REFERENCES "public"."generation_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_provider_job_id_provider_jobs_id_fk" FOREIGN KEY ("provider_job_id") REFERENCES "public"."provider_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_cover_image_id_cover_images_id_fk" FOREIGN KEY ("cover_image_id") REFERENCES "public"."cover_images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_session_queue_items" ADD CONSTRAINT "activity_session_queue_items_activity_session_id_activity_sessions_id_fk" FOREIGN KEY ("activity_session_id") REFERENCES "public"."activity_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_session_queue_items" ADD CONSTRAINT "activity_session_queue_items_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_session_queue_items" ADD CONSTRAINT "activity_session_queue_items_generation_request_id_generation_requests_id_fk" FOREIGN KEY ("generation_request_id") REFERENCES "public"."generation_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_sessions" ADD CONSTRAINT "activity_sessions_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_sessions" ADD CONSTRAINT "activity_sessions_current_track_id_tracks_id_fk" FOREIGN KEY ("current_track_id") REFERENCES "public"."tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_sessions" ADD CONSTRAINT "activity_sessions_current_queue_item_id_activity_session_queue_items_id_fk" FOREIGN KEY ("current_queue_item_id") REFERENCES "public"."activity_session_queue_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_activity_session_id_activity_sessions_id_fk" FOREIGN KEY ("activity_session_id") REFERENCES "public"."activity_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_events" ADD CONSTRAINT "playback_events_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_events" ADD CONSTRAINT "playback_events_activity_session_id_activity_sessions_id_fk" FOREIGN KEY ("activity_session_id") REFERENCES "public"."activity_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_events" ADD CONSTRAINT "playback_events_queue_item_id_activity_session_queue_items_id_fk" FOREIGN KEY ("queue_item_id") REFERENCES "public"."activity_session_queue_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_events" ADD CONSTRAINT "playback_events_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletion_queue_items" ADD CONSTRAINT "deletion_queue_items_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletion_queue_items" ADD CONSTRAINT "deletion_queue_items_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "taste_profiles_owner_user_id_unique" ON "taste_profiles" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "generation_requests_owner_user_id_idx" ON "generation_requests" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "generation_requests_activity_session_id_idx" ON "generation_requests" USING btree ("activity_session_id");--> statement-breakpoint
CREATE INDEX "generation_requests_status_idx" ON "generation_requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_jobs_generation_request_id_unique" ON "provider_jobs" USING btree ("generation_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_jobs_provider_key_task_id_unique" ON "provider_jobs" USING btree ("provider_key","provider_task_id") WHERE "provider_jobs"."provider_task_id" is not null;--> statement-breakpoint
CREATE INDEX "provider_jobs_normalized_status_idx" ON "provider_jobs" USING btree ("normalized_status");--> statement-breakpoint
CREATE INDEX "provider_jobs_next_poll_at_idx" ON "provider_jobs" USING btree ("next_poll_at");--> statement-breakpoint
CREATE INDEX "track_audio_assets_track_id_idx" ON "track_audio_assets" USING btree ("track_id");--> statement-breakpoint
CREATE INDEX "tracks_owner_user_id_idx" ON "tracks" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "tracks_created_at_idx" ON "tracks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tracks_saved_at_idx" ON "tracks" USING btree ("saved_at");--> statement-breakpoint
CREATE INDEX "tracks_favorited_at_idx" ON "tracks" USING btree ("favorited_at");--> statement-breakpoint
CREATE INDEX "tracks_status_idx" ON "tracks" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "tracks_provider_key_track_id_unique" ON "tracks" USING btree ("provider_key","provider_track_id") WHERE "tracks"."provider_track_id" is not null;--> statement-breakpoint
CREATE INDEX "queue_items_session_position_idx" ON "activity_session_queue_items" USING btree ("activity_session_id","position");--> statement-breakpoint
CREATE INDEX "queue_items_state_idx" ON "activity_session_queue_items" USING btree ("state");--> statement-breakpoint
CREATE INDEX "activity_sessions_owner_user_id_idx" ON "activity_sessions" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_sessions_one_active_per_owner" ON "activity_sessions" USING btree ("owner_user_id") WHERE "activity_sessions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "feedback_events_track_id_idx" ON "feedback_events" USING btree ("track_id");--> statement-breakpoint
CREATE INDEX "playback_events_session_created_at_idx" ON "playback_events" USING btree ("activity_session_id","created_at");--> statement-breakpoint
CREATE INDEX "playback_events_queue_item_id_idx" ON "playback_events" USING btree ("queue_item_id");--> statement-breakpoint
CREATE INDEX "deletion_queue_items_delete_after_idx" ON "deletion_queue_items" USING btree ("delete_after");--> statement-breakpoint
CREATE INDEX "deletion_queue_items_processed_at_idx" ON "deletion_queue_items" USING btree ("processed_at");