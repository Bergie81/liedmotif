-- Retire the `cinematic` cover style. Its lane folds into `photographic` (which
-- now carries a cinematic narrative-still treatment), so every persisted
-- selection is remapped before the enum is rebuilt without the value. Immutable
-- ledger plans (`session_cover_generations.plan`) keep their historical strings.
UPDATE "activity_sessions" SET "cover_style" = 'photographic' WHERE "cover_style" = 'cinematic';--> statement-breakpoint
UPDATE "cover_art_studio_candidates" SET "requested_style" = 'photographic' WHERE "requested_style" = 'cinematic';--> statement-breakpoint
UPDATE "cover_art_studio_candidates" SET "resolved_style" = 'photographic' WHERE "resolved_style" = 'cinematic';--> statement-breakpoint
UPDATE "cover_art_studio_batches"
SET "requested_styles" = (
  SELECT jsonb_agg(
    CASE WHEN elements.entry = '"cinematic"'::jsonb THEN '"photographic"'::jsonb ELSE elements.entry END
    ORDER BY elements.ordinality
  )
  FROM jsonb_array_elements("requested_styles") WITH ORDINALITY AS elements(entry, ordinality)
)
WHERE "requested_styles" @> '["cinematic"]'::jsonb;--> statement-breakpoint
UPDATE "app_settings"
SET "value" = jsonb_set("value", '{defaultStyle}', '"photographic"')
WHERE "key" = 'coverArt' AND "value" ->> 'defaultStyle' = 'cinematic';--> statement-breakpoint
-- The check constraint references the enum type; drop it while the type is
-- rebuilt and restore it afterwards.
ALTER TABLE "activity_sessions" DROP CONSTRAINT "activity_sessions_authoritative_cover_style";--> statement-breakpoint
ALTER TABLE "activity_sessions" ALTER COLUMN "cover_style" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "activity_sessions" ALTER COLUMN "cover_style" SET DEFAULT 'auto'::text;--> statement-breakpoint
ALTER TABLE "cover_art_studio_candidates" ALTER COLUMN "requested_style" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "cover_art_studio_candidates" ALTER COLUMN "resolved_style" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."cover_style";--> statement-breakpoint
CREATE TYPE "public"."cover_style" AS ENUM('auto', 'photographic', 'minimal', 'abstract', 'drawing', 'collage', 'retro', 'surreal', 'futuristic', 'poster_art', 'custom');--> statement-breakpoint
ALTER TABLE "activity_sessions" ALTER COLUMN "cover_style" SET DEFAULT 'auto'::"public"."cover_style";--> statement-breakpoint
ALTER TABLE "activity_sessions" ALTER COLUMN "cover_style" SET DATA TYPE "public"."cover_style" USING "cover_style"::"public"."cover_style";--> statement-breakpoint
ALTER TABLE "cover_art_studio_candidates" ALTER COLUMN "requested_style" SET DATA TYPE "public"."cover_style" USING "requested_style"::"public"."cover_style";--> statement-breakpoint
ALTER TABLE "cover_art_studio_candidates" ALTER COLUMN "resolved_style" SET DATA TYPE "public"."cover_style" USING "resolved_style"::"public"."cover_style";--> statement-breakpoint
ALTER TABLE "activity_sessions" ADD CONSTRAINT "activity_sessions_authoritative_cover_style" CHECK ((
        ("activity_sessions"."cover_style" = 'custom' and btrim(coalesce("activity_sessions"."cover_style_hint", '')) <> '')
        or
        ("activity_sessions"."cover_style" <> 'custom' and "activity_sessions"."cover_style_hint" is null and "activity_sessions"."cover_style_hint_normalized" is null)
      ));
