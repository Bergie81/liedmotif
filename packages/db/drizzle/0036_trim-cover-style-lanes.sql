-- Retire the `abstract`, `collage`, `retro`, `surreal`, and `futuristic` cover
-- styles. Each lane folds into its nearest kept lane (abstract → minimal,
-- collage → drawing, retro/surreal → photographic, futuristic → minimal), so
-- every persisted selection is remapped before the enum is rebuilt without the
-- values. Immutable ledger plans (`session_cover_generations.plan`) keep their
-- historical strings.
UPDATE "activity_sessions"
SET "cover_style" = (CASE "cover_style"
  WHEN 'abstract' THEN 'minimal'
  WHEN 'collage' THEN 'drawing'
  WHEN 'retro' THEN 'photographic'
  WHEN 'surreal' THEN 'photographic'
  WHEN 'futuristic' THEN 'minimal'
END)::"public"."cover_style"
WHERE "cover_style" IN ('abstract', 'collage', 'retro', 'surreal', 'futuristic');--> statement-breakpoint
UPDATE "cover_art_studio_candidates"
SET "requested_style" = (CASE "requested_style"
  WHEN 'abstract' THEN 'minimal'
  WHEN 'collage' THEN 'drawing'
  WHEN 'retro' THEN 'photographic'
  WHEN 'surreal' THEN 'photographic'
  WHEN 'futuristic' THEN 'minimal'
END)::"public"."cover_style"
WHERE "requested_style" IN ('abstract', 'collage', 'retro', 'surreal', 'futuristic');--> statement-breakpoint
UPDATE "cover_art_studio_candidates"
SET "resolved_style" = (CASE "resolved_style"
  WHEN 'abstract' THEN 'minimal'
  WHEN 'collage' THEN 'drawing'
  WHEN 'retro' THEN 'photographic'
  WHEN 'surreal' THEN 'photographic'
  WHEN 'futuristic' THEN 'minimal'
END)::"public"."cover_style"
WHERE "resolved_style" IN ('abstract', 'collage', 'retro', 'surreal', 'futuristic');--> statement-breakpoint
-- Batch style lists are unique per batch, so the remap dedupes (keeping first
-- position) in case a batch requested both a retired lane and its target.
UPDATE "cover_art_studio_batches"
SET "requested_styles" = (
  SELECT jsonb_agg(mapped.entry ORDER BY mapped.first_ordinality)
  FROM (
    SELECT remapped.entry, min(remapped.ordinality) AS first_ordinality
    FROM (
      SELECT
        CASE elements.entry
          WHEN '"abstract"'::jsonb THEN '"minimal"'::jsonb
          WHEN '"collage"'::jsonb THEN '"drawing"'::jsonb
          WHEN '"retro"'::jsonb THEN '"photographic"'::jsonb
          WHEN '"surreal"'::jsonb THEN '"photographic"'::jsonb
          WHEN '"futuristic"'::jsonb THEN '"minimal"'::jsonb
          ELSE elements.entry
        END AS entry,
        elements.ordinality
      FROM jsonb_array_elements("requested_styles") WITH ORDINALITY AS elements(entry, ordinality)
    ) remapped
    GROUP BY remapped.entry
  ) mapped
)
WHERE "requested_styles" ?| array['abstract', 'collage', 'retro', 'surreal', 'futuristic'];--> statement-breakpoint
UPDATE "app_settings"
SET "value" = jsonb_set("value", '{defaultStyle}',
  CASE "value" ->> 'defaultStyle'
    WHEN 'abstract' THEN '"minimal"'::jsonb
    WHEN 'collage' THEN '"drawing"'::jsonb
    WHEN 'retro' THEN '"photographic"'::jsonb
    WHEN 'surreal' THEN '"photographic"'::jsonb
    WHEN 'futuristic' THEN '"minimal"'::jsonb
  END)
WHERE "key" = 'coverArt'
  AND "value" ->> 'defaultStyle' IN ('abstract', 'collage', 'retro', 'surreal', 'futuristic');--> statement-breakpoint
-- The check constraint references the enum type; drop it while the type is
-- rebuilt and restore it afterwards.
ALTER TABLE "activity_sessions" DROP CONSTRAINT "activity_sessions_authoritative_cover_style";--> statement-breakpoint
ALTER TABLE "activity_sessions" ALTER COLUMN "cover_style" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "activity_sessions" ALTER COLUMN "cover_style" SET DEFAULT 'auto'::text;--> statement-breakpoint
ALTER TABLE "cover_art_studio_candidates" ALTER COLUMN "requested_style" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "cover_art_studio_candidates" ALTER COLUMN "resolved_style" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."cover_style";--> statement-breakpoint
CREATE TYPE "public"."cover_style" AS ENUM('auto', 'photographic', 'minimal', 'drawing', 'poster_art', 'custom');--> statement-breakpoint
ALTER TABLE "activity_sessions" ALTER COLUMN "cover_style" SET DEFAULT 'auto'::"public"."cover_style";--> statement-breakpoint
ALTER TABLE "activity_sessions" ALTER COLUMN "cover_style" SET DATA TYPE "public"."cover_style" USING "cover_style"::"public"."cover_style";--> statement-breakpoint
ALTER TABLE "cover_art_studio_candidates" ALTER COLUMN "requested_style" SET DATA TYPE "public"."cover_style" USING "requested_style"::"public"."cover_style";--> statement-breakpoint
ALTER TABLE "cover_art_studio_candidates" ALTER COLUMN "resolved_style" SET DATA TYPE "public"."cover_style" USING "resolved_style"::"public"."cover_style";--> statement-breakpoint
ALTER TABLE "activity_sessions" ADD CONSTRAINT "activity_sessions_authoritative_cover_style" CHECK ((
        ("activity_sessions"."cover_style" = 'custom' and btrim(coalesce("activity_sessions"."cover_style_hint", '')) <> '')
        or
        ("activity_sessions"."cover_style" <> 'custom' and "activity_sessions"."cover_style_hint" is null and "activity_sessions"."cover_style_hint_normalized" is null)
      ));
