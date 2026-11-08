CREATE INDEX "playlists_id_text_idx" ON "playlists" USING btree (("id"::text));--> statement-breakpoint
CREATE INDEX "activity_sessions_id_text_idx" ON "activity_sessions" USING btree (("id"::text));