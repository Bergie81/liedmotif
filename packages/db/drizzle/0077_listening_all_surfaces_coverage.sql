-- `collection_started_at` promises that listening on every surface was recorded
-- from that instant. Playlist and preview listening is recorded only from this
-- migration on, so an account whose collection began earlier restarts its claim here.
UPDATE "listening_preferences" SET "collection_started_at" = now();
