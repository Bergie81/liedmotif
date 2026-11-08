-- A cover ledger row is the spend record the cover budgets count, so deleting
-- its Playlist clears the edge instead of erasing the paid attempt.
ALTER TABLE "session_cover_generations" DROP CONSTRAINT "session_cover_generations_playlist_id_playlists_id_fk";
--> statement-breakpoint
ALTER TABLE "session_cover_generations" ADD CONSTRAINT "session_cover_generations_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE set null ON UPDATE no action;