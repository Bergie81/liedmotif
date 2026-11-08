CREATE TYPE "public"."session_end_reason" AS ENUM('user_stopped', 'completed_duration', 'superseded', 'idle_timeout');--> statement-breakpoint
CREATE TYPE "public"."session_generation_status" AS ENUM('ok', 'repeat_cost_limit', 'provider_credits', 'provider_rate_limited', 'worker_stalled', 'provider_error');--> statement-breakpoint
CREATE TYPE "public"."session_mode" AS ENUM('keep_going', 'repeat');--> statement-breakpoint
DROP INDEX IF EXISTS "activity_sessions_one_active_per_owner";--> statement-breakpoint
ALTER TABLE "activity_sessions" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "activity_sessions" ALTER COLUMN "status" SET DEFAULT 'active'::text;--> statement-breakpoint
DROP TYPE "public"."activity_session_status";--> statement-breakpoint
CREATE TYPE "public"."activity_session_status" AS ENUM('active', 'stopped');--> statement-breakpoint
ALTER TABLE "activity_sessions" ALTER COLUMN "status" SET DEFAULT 'active'::"public"."activity_session_status";--> statement-breakpoint
ALTER TABLE "activity_sessions" ALTER COLUMN "status" SET DATA TYPE "public"."activity_session_status" USING (CASE WHEN "status" = 'active' THEN 'active' ELSE 'stopped' END)::"public"."activity_session_status";--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "musical_key" text;--> statement-breakpoint
ALTER TABLE "activity_sessions" ADD COLUMN "cover_image_id" uuid;--> statement-breakpoint
ALTER TABLE "activity_sessions" ADD COLUMN "session_mode" "session_mode" DEFAULT 'keep_going' NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_sessions" ADD COLUMN "generation_status" "session_generation_status" DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_sessions" ADD COLUMN "end_reason" "session_end_reason";--> statement-breakpoint
ALTER TABLE "activity_sessions" ADD COLUMN "idle_auto_stop_after_minutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_sessions" ADD COLUMN "last_resumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "activity_sessions" ADD CONSTRAINT "activity_sessions_cover_image_id_cover_images_id_fk" FOREIGN KEY ("cover_image_id") REFERENCES "public"."cover_images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_sessions" DROP COLUMN "pause_reason";--> statement-breakpoint
ALTER TABLE "activity_sessions" DROP COLUMN "idle_auto_pause_after_minutes";--> statement-breakpoint
ALTER TABLE "activity_sessions" DROP COLUMN "paused_at";--> statement-breakpoint
DROP TYPE "public"."session_pause_reason";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "activity_sessions_one_active_per_owner" ON "activity_sessions" USING btree ("owner_user_id") WHERE "activity_sessions"."status" = 'active';