-- Search's Playlist surface. Its member-title probe is an `exists`
-- subplan whose inner `t.title ilike '%q%'` stands alone, so it takes an index
-- plan the other surfaces' multi-field OR cannot. `pg_trgm` is installed by
-- 0065; `gin_trgm_ops` resolves out of the extension's schema.
CREATE INDEX "tracks_title_trgm_idx" ON "tracks" USING gin ("title" gin_trgm_ops) WHERE "tracks"."title" is not null;
