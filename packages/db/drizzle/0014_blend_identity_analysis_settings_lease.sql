CREATE TYPE "public"."analysis_status" AS ENUM('pending', 'measured', 'partial', 'unavailable', 'failed');--> statement-breakpoint
CREATE TYPE "public"."bpm_source" AS ENUM('measured', 'anchored');--> statement-breakpoint
CREATE TABLE "user_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_loop_leases" (
	"activity_session_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"epoch" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_loop_leases_activity_session_id_client_id_pk" PRIMARY KEY("activity_session_id","client_id")
);
--> statement-breakpoint
ALTER TABLE "tracks" ALTER COLUMN "bpm_estimate" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "generation_requests" ADD COLUMN "style_revision" integer;--> statement-breakpoint
ALTER TABLE "generation_requests" ADD COLUMN "target_bpm" double precision;--> statement-breakpoint
ALTER TABLE "generation_requests" ADD COLUMN "target_key" text;--> statement-breakpoint
ALTER TABLE "generation_requests" ADD COLUMN "style_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "lufs_integrated" double precision;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "true_peak_db" double precision;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "head_beat_anchor_seconds" double precision;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "head_beat_period_seconds" double precision;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "tail_beat_anchor_seconds" double precision;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "tail_beat_period_seconds" double precision;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "analysis_status" "analysis_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "analysis_version" integer;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "analysis_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "bpm_source" "bpm_source";--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "bpm_confidence" double precision;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "reroll_pending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "activity_sessions" ADD COLUMN "style_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_loop_leases" ADD CONSTRAINT "session_loop_leases_activity_session_id_activity_sessions_id_fk" FOREIGN KEY ("activity_session_id") REFERENCES "public"."activity_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_settings_owner_key_unique" ON "user_settings" USING btree ("owner_user_id","key");