CREATE TYPE "public"."cover_style" AS ENUM('auto', 'photographic', 'cinematic', 'minimal', 'abstract', 'drawing', 'collage', 'retro', 'surreal', 'futuristic', 'poster_art');--> statement-breakpoint
ALTER TABLE "activity_sessions" ADD COLUMN "cover_style" "cover_style" DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_sessions" ADD COLUMN "cover_style_hint" text;