-- Cascade/drain FK indexes: Postgres does not auto-index FK columns, so RI
-- probes on delete (and the deletion-queue drain's storage-key EXISTS) were
-- sequential scans of child tables per deleted parent row.
--
-- Note on playback_events_track_id_idx: the existing partial index
-- playback_events_started_track_idx (WHERE event_type = 'started') cannot serve
-- the FK set-null probe — the RI trigger must find ended/skipped/failed rows
-- too — so the new full track_id index is not redundant with it.
CREATE INDEX "provider_credentials_owner_idx" ON "provider_credentials" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "usage_events_user_id_idx" ON "usage_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invites_target_user_idx" ON "invites" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "invites_created_by_idx" ON "invites" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "invites_consumed_by_idx" ON "invites" USING btree ("consumed_by_user_id");--> statement-breakpoint
CREATE INDEX "track_audio_assets_storage_key_idx" ON "track_audio_assets" USING btree ("storage_key") WHERE "track_audio_assets"."storage_key" is not null;--> statement-breakpoint
CREATE INDEX "tracks_cover_image_id_idx" ON "tracks" USING btree ("cover_image_id") WHERE "tracks"."cover_image_id" is not null;--> statement-breakpoint
CREATE INDEX "playlists_cover_image_id_idx" ON "playlists" USING btree ("cover_image_id") WHERE "playlists"."cover_image_id" is not null;--> statement-breakpoint
CREATE INDEX "queue_items_generation_request_id_idx" ON "activity_session_queue_items" USING btree ("generation_request_id");--> statement-breakpoint
CREATE INDEX "activity_sessions_current_track_idx" ON "activity_sessions" USING btree ("current_track_id");--> statement-breakpoint
CREATE INDEX "activity_sessions_current_queue_item_idx" ON "activity_sessions" USING btree ("current_queue_item_id");--> statement-breakpoint
CREATE INDEX "activity_sessions_cover_image_id_idx" ON "activity_sessions" USING btree ("cover_image_id") WHERE "activity_sessions"."cover_image_id" is not null;--> statement-breakpoint
CREATE INDEX "session_cover_generations_playlist_idx" ON "session_cover_generations" USING btree ("playlist_id");--> statement-breakpoint
CREATE INDEX "cover_art_studio_candidates_owner_batch_idx" ON "cover_art_studio_candidates" USING btree ("owner_user_id","batch_id");--> statement-breakpoint
CREATE INDEX "feedback_events_session_id_idx" ON "feedback_events" USING btree ("activity_session_id");--> statement-breakpoint
CREATE INDEX "feedback_events_user_id_idx" ON "feedback_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "playback_events_track_id_idx" ON "playback_events" USING btree ("track_id");--> statement-breakpoint
CREATE INDEX "playback_events_owner_user_id_idx" ON "playback_events" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "deletion_queue_items_track_id_idx" ON "deletion_queue_items" USING btree ("track_id");--> statement-breakpoint
CREATE INDEX "deletion_queue_items_owner_idx" ON "deletion_queue_items" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "voice_recordings_owner_idx" ON "voice_recordings" USING btree ("owner_user_id");