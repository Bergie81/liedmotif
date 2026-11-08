CREATE TYPE "public"."session_cover_trigger" AS ENUM('initial', 'recovery', 'user_regenerate');--> statement-breakpoint
DROP INDEX "session_cover_generations_owner_session_unique";--> statement-breakpoint
ALTER TABLE "session_cover_generations" ADD COLUMN "trigger" "session_cover_trigger" DEFAULT 'initial' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "session_cover_generations_owner_session_live_unique" ON "session_cover_generations" USING btree ("owner_user_id","activity_session_id") WHERE state in ('reserved', 'planned', 'submitting', 'storing');