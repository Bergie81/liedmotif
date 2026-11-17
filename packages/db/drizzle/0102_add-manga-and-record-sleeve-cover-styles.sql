-- Recreate `cover_style` with the `record_sleeve` and `manga` lanes, in the shared
-- `COVER_STYLES` contract order (parity-guarded). Same recreate recipe as migration 0055: the
-- check constraint references the enum column, so it is dropped while the type
-- is rebuilt and restored afterwards. Existing values all survive the cast.
ALTER TABLE "activity_sessions" DROP CONSTRAINT "activity_sessions_authoritative_cover_style";--> statement-breakpoint
ALTER TABLE "activity_sessions" ALTER COLUMN "cover_style" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "activity_sessions" ALTER COLUMN "cover_style" SET DEFAULT 'auto'::text;--> statement-breakpoint
DROP TYPE "public"."cover_style";--> statement-breakpoint
CREATE TYPE "public"."cover_style" AS ENUM('auto', 'record_sleeve', 'poster_art', 'photographic', 'manga', 'drawing', 'minimal', 'custom');--> statement-breakpoint
ALTER TABLE "activity_sessions" ALTER COLUMN "cover_style" SET DEFAULT 'auto'::"public"."cover_style";--> statement-breakpoint
ALTER TABLE "activity_sessions" ALTER COLUMN "cover_style" SET DATA TYPE "public"."cover_style" USING "cover_style"::"public"."cover_style";--> statement-breakpoint
ALTER TABLE "activity_sessions" ADD CONSTRAINT "activity_sessions_authoritative_cover_style" CHECK ((
        ("activity_sessions"."cover_style" = 'custom' and btrim(coalesce("activity_sessions"."cover_style_hint", '')) <> '')
        or
        ("activity_sessions"."cover_style" <> 'custom' and "activity_sessions"."cover_style_hint" is null and "activity_sessions"."cover_style_hint_normalized" is null)
      ));
