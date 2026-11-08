CREATE INDEX "tracks_generation_request_id_idx" ON "tracks" USING btree ("generation_request_id");--> statement-breakpoint
CREATE INDEX "tracks_provider_job_id_idx" ON "tracks" USING btree ("provider_job_id");--> statement-breakpoint
CREATE INDEX "tracks_owner_saved_id_idx" ON "tracks" USING btree ("owner_user_id","saved_at","id");--> statement-breakpoint
CREATE INDEX "tracks_owner_favorited_id_idx" ON "tracks" USING btree ("owner_user_id","favorited_at","id");--> statement-breakpoint
CREATE INDEX "tracks_owner_created_id_idx" ON "tracks" USING btree ("owner_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "queue_items_track_id_idx" ON "activity_session_queue_items" USING btree ("track_id") WHERE "activity_session_queue_items"."track_id" is not null;