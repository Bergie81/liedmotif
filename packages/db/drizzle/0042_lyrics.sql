ALTER TABLE "tracks" ADD COLUMN "lyrics" text;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "timed_lyrics" jsonb;--> statement-breakpoint
-- Pre-existing tracks were materialized before vocal_mode was stamped, so every
-- row still holds the column default. Recover the real mode from the request's
-- (or, failing that, the session's) Style Snapshot so old vocal tracks can have
-- their lyrics backfilled.
UPDATE "tracks" t
SET "vocal_mode" = 'vocal'
FROM "generation_requests" gr
LEFT JOIN "activity_sessions" s ON s."id" = gr."activity_session_id"
WHERE t."generation_request_id" = gr."id"
  AND t."vocal_mode" = 'instrumental'
  AND coalesce(gr."style_snapshot"->>'vocalMode', s."session_style_snapshot"->>'vocalMode') = 'vocal';
