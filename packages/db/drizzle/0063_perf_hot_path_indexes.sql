DROP INDEX "tracks_owner_user_id_idx";--> statement-breakpoint
DROP INDEX "tracks_saved_at_idx";--> statement-breakpoint
DROP INDEX "tracks_favorited_at_idx";--> statement-breakpoint
DROP INDEX "playlist_tracks_playlist_id_idx";--> statement-breakpoint
CREATE INDEX "cover_images_generated_created_idx" ON "cover_images" USING btree ("created_at") WHERE "cover_images"."source_type" = 'generated';--> statement-breakpoint
CREATE INDEX "cover_images_uploaded_owner_idx" ON "cover_images" USING btree (("provenance" ->> 'ownerUserId'),"created_at" desc) WHERE "cover_images"."source_type" = 'uploaded';--> statement-breakpoint
CREATE INDEX "generation_requests_failed_updated_idx" ON "generation_requests" USING btree ("updated_at" desc) WHERE "generation_requests"."status" = 'failed';--> statement-breakpoint
CREATE INDEX "provider_jobs_ready_updated_idx" ON "provider_jobs" USING btree ("updated_at") WHERE "provider_jobs"."normalized_status" = 'ready' and "provider_jobs"."provider_task_id" is not null;--> statement-breakpoint
CREATE INDEX "provider_jobs_spend_window_idx" ON "provider_jobs" USING btree ("created_at") WHERE "provider_jobs"."submit_state" in ('submitting', 'submitted', 'submit_unknown');--> statement-breakpoint
CREATE INDEX "provider_jobs_submitted_at_idx" ON "provider_jobs" USING btree ("last_submit_attempt_at" desc) WHERE "provider_jobs"."provider_task_id" is not null;--> statement-breakpoint
CREATE INDEX "track_audio_assets_local_created_idx" ON "track_audio_assets" USING btree ("created_at" desc) WHERE "track_audio_assets"."asset_type" = 'local_original' and "track_audio_assets"."storage_key" is not null;--> statement-breakpoint
CREATE INDEX "tracks_analysis_backlog_idx" ON "tracks" USING btree ("analysis_version","created_at") WHERE "tracks"."status" = 'ready';--> statement-breakpoint
CREATE INDEX "playlist_tracks_playlist_position_idx" ON "playlist_tracks" USING btree ("playlist_id","position");--> statement-breakpoint
CREATE INDEX "playlists_owner_activity_idx" ON "playlists" USING btree ("owner_user_id",(greatest("updated_at", "last_played_at")) desc,"id") WHERE "playlists"."kind" = 'user';--> statement-breakpoint
CREATE INDEX "activity_sessions_owner_last_active_idx" ON "activity_sessions" USING btree ("owner_user_id",(coalesce("last_playback_report_at", "stopped_at", "last_resumed_at", "started_at")) desc,"id" desc) WHERE "activity_sessions"."status" = 'stopped';--> statement-breakpoint
CREATE INDEX "session_cover_generations_live_updated_idx" ON "session_cover_generations" USING btree ("updated_at") WHERE state in ('reserved', 'planned', 'submitting', 'storing');