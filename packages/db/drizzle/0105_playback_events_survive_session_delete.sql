ALTER TABLE "playback_events" DROP CONSTRAINT "playback_events_activity_session_id_activity_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "playback_events" ALTER COLUMN "activity_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "playback_events" ADD CONSTRAINT "playback_events_activity_session_id_activity_sessions_id_fk" FOREIGN KEY ("activity_session_id") REFERENCES "public"."activity_sessions"("id") ON DELETE set null ON UPDATE no action;