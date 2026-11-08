DROP INDEX "cover_art_studio_candidates_batch_style_unique";--> statement-breakpoint
ALTER TABLE "cover_art_studio_batches" ADD COLUMN "client_request_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;