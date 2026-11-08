ALTER TABLE "listening_occurrences" ADD COLUMN "played_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "listening_occurrences" ADD COLUMN "start_origin" text;--> statement-breakpoint
-- Occurrences recorded before overlap was divided were credited whole: what they played is what they were credited.
UPDATE "listening_occurrences" SET "played_ms" = "listened_ms";
