-- Record which stored covers already carry the Liedmotif badge.
--
-- The badge moves out of cover storage and into the embed-time album-art
-- rendition, which composites it exactly when a cover's stored bytes are
-- clean. Legacy rows were badged at store time and their originals were never
-- retained, so they are marked `branded` to keep exports from stacking a
-- second badge; the built-in placeholder is brand art by design and must never
-- receive one either.
--
-- IF NOT EXISTS: the backfill test re-runs this file against an
-- already-migrated database.
ALTER TABLE "cover_images" ADD COLUMN IF NOT EXISTS "branded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Badged at store time:
--   - generated-family rows whose provenance recorded the branded treatment
--     (rows older than that provenance field predate badge compositing and
--     really are clean);
--   - Session cover uploads (identified by the session in their provenance;
--     playlist uploads were never badged);
--   - the placeholder row.
UPDATE "cover_images"
SET "branded" = true
WHERE "provenance" ->> 'branded' = 'true'
   OR ("source_type" = 'uploaded' AND "provenance" ->> 'activitySessionId' IS NOT NULL)
   OR "source_type" = 'placeholder';
