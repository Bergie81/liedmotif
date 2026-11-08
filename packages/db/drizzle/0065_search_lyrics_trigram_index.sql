-- Search's Lyrics surface. `pg_trgm` is
-- trusted from Postgres 13 on, so the database owner installs it without
-- superuser; `gin_trgm_ops` resolves out of the extension's schema, so the
-- extension must exist before the index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "tracks_lyrics_trgm_idx" ON "tracks" USING gin ("lyrics" gin_trgm_ops) WHERE "tracks"."lyrics" is not null;
