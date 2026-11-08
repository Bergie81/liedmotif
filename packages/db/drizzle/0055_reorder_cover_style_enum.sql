-- Recreate `cover_style` with `poster_art` (Artistic) leading the preset lanes,
-- matching the shared `COVER_STYLES` contract order (parity-guarded): Artistic
-- is the lane `auto` favors by default, so it lists first everywhere. Same
-- value set, order only — no data remap. Same recreate recipe as migration
-- 0036: the check constraint references the enum column, so it is dropped
-- while the type is rebuilt and restored afterwards.
ALTER TABLE "activity_sessions" DROP CONSTRAINT "activity_sessions_authoritative_cover_style";--> statement-breakpoint
ALTER TABLE "activity_sessions" ALTER COLUMN "cover_style" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "activity_sessions" ALTER COLUMN "cover_style" SET DEFAULT 'auto'::text;--> statement-breakpoint
ALTER TABLE "cover_art_studio_candidates" ALTER COLUMN "requested_style" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "cover_art_studio_candidates" ALTER COLUMN "resolved_style" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."cover_style";--> statement-breakpoint
CREATE TYPE "public"."cover_style" AS ENUM('auto', 'poster_art', 'photographic', 'minimal', 'drawing', 'custom');--> statement-breakpoint
ALTER TABLE "activity_sessions" ALTER COLUMN "cover_style" SET DEFAULT 'auto'::"public"."cover_style";--> statement-breakpoint
ALTER TABLE "activity_sessions" ALTER COLUMN "cover_style" SET DATA TYPE "public"."cover_style" USING "cover_style"::"public"."cover_style";--> statement-breakpoint
ALTER TABLE "cover_art_studio_candidates" ALTER COLUMN "requested_style" SET DATA TYPE "public"."cover_style" USING "requested_style"::"public"."cover_style";--> statement-breakpoint
ALTER TABLE "cover_art_studio_candidates" ALTER COLUMN "resolved_style" SET DATA TYPE "public"."cover_style" USING "resolved_style"::"public"."cover_style";--> statement-breakpoint
ALTER TABLE "activity_sessions" ADD CONSTRAINT "activity_sessions_authoritative_cover_style" CHECK ((
        ("activity_sessions"."cover_style" = 'custom' and btrim(coalesce("activity_sessions"."cover_style_hint", '')) <> '')
        or
        ("activity_sessions"."cover_style" <> 'custom' and "activity_sessions"."cover_style_hint" is null and "activity_sessions"."cover_style_hint_normalized" is null)
      ));
