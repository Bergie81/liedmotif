CREATE INDEX "playback_events_started_track_idx" ON "playback_events" USING btree ("track_id") WHERE "playback_events"."event_type" = 'started' and "playback_events"."track_id" is not null;
