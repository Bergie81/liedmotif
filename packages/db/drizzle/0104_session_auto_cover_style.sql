-- The text LLM's pick of the cover preset Auto resolves to, stored with the
-- cover concept on Sessions and on Surprise Me proposals. Null where no text LLM
-- answered with a valid preset, including every Session created before it.
ALTER TABLE "activity_sessions" ADD COLUMN "auto_cover_style" "cover_style";--> statement-breakpoint
ALTER TABLE "surprise_proposals" ADD COLUMN "auto_cover_style" "cover_style";