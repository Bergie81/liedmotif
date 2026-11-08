ALTER TABLE "listening_preferences" ADD COLUMN "history_cleared_at" timestamp with time zone;--> statement-breakpoint
-- Removed music stays behind as a tombstone row, so ON DELETE SET NULL never
-- severed these links. Counts and the opaque analytics identity are untouched.
UPDATE "listening_occurrences" SET "track_id" = NULL, "session_id" = NULL
WHERE "track_id" IN (SELECT "id" FROM "tracks" WHERE "status" IN ('rejected', 'deleted'));--> statement-breakpoint
UPDATE "generation_outputs" SET "track_id" = NULL
WHERE "track_id" IN (SELECT "id" FROM "tracks" WHERE "status" IN ('rejected', 'deleted'));
