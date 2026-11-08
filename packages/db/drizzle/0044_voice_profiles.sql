CREATE TYPE "public"."voice_profile_status" AS ENUM('draft', 'validating_source', 'awaiting_verification', 'creating_voice', 'ready', 'failed', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."voice_recording_kind" AS ENUM('source', 'verification');--> statement-breakpoint
CREATE TABLE "voice_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"display_name" text DEFAULT 'My voice' NOT NULL,
	"status" "voice_profile_status" DEFAULT 'draft' NOT NULL,
	"provider_key" text NOT NULL,
	"provider_validation_task_id" text,
	"provider_voice_task_id" text,
	"provider_voice_id" text,
	"verification_phrase" text,
	"language" text,
	"consent_version" text NOT NULL,
	"consent_accepted_at" timestamp with time zone NOT NULL,
	"error_code" text,
	"error_message_safe" text,
	"last_polled_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"voice_profile_id" uuid NOT NULL,
	"kind" "voice_recording_kind" NOT NULL,
	"storage_provider" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"duration_seconds" double precision,
	"peak_dbfs" double precision,
	"loudness_lufs" double precision,
	"capture_settings" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD CONSTRAINT "voice_profiles_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_recordings" ADD CONSTRAINT "voice_recordings_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_recordings" ADD CONSTRAINT "voice_recordings_voice_profile_id_voice_profiles_id_fk" FOREIGN KEY ("voice_profile_id") REFERENCES "public"."voice_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "voice_profiles_owner_user_id_unique" ON "voice_profiles" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_recordings_profile_kind_unique" ON "voice_recordings" USING btree ("voice_profile_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_recordings_storage_key_unique" ON "voice_recordings" USING btree ("storage_key");