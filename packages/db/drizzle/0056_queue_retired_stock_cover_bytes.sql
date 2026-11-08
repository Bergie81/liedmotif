-- Migration 0054 deleted the bundled stock-cover ROWS, which were the only
-- reference to their WebP objects — so the bytes are unreachable from the app
-- while still occupying the `/data` volume. Hand the keys to the deletion
-- queue so the recurring `process-deletion-queue` job reclaims them through the
-- single path that owns file deletion (it skips any key a live audio asset still
-- references, which a cover key never is).
--
-- The queue tracks ownership even though these objects were instance-global, so
-- the items are attributed to the first admin. An install that never seeded the
-- stock library — or has no user yet — matches nothing and this is a no-op.
INSERT INTO "deletion_queue_items" ("owner_user_id", "storage_key", "reason", "delete_after")
SELECT "admin"."id", "asset"."storage_key", 'retired_stock_cover', now()
FROM (SELECT "id" FROM "user" ORDER BY "created_at" ASC LIMIT 1) AS "admin"
CROSS JOIN (
  VALUES
    ('covers/stock/stock-lofi-01.webp'),
    ('covers/stock/stock-ambient-02.webp'),
    ('covers/stock/stock-synthwave-03.webp'),
    ('covers/stock/stock-piano-04.webp'),
    ('covers/stock/stock-jazz-05.webp'),
    ('covers/stock/stock-indie-rock-06.webp'),
    ('covers/stock/stock-acoustic-07.webp'),
    ('covers/stock/stock-house-08.webp'),
    ('covers/stock/stock-cinematic-09.webp'),
    ('covers/stock/stock-downtempo-10.webp'),
    ('covers/stock/stock-meditation-11.webp'),
    ('covers/stock/stock-workout-12.webp'),
    ('covers/stock/stock-minimal-techno-13.webp'),
    ('covers/stock/stock-dream-pop-14.webp')
) AS "asset"("storage_key");--> statement-breakpoint
-- 0054 also repointed stock-covered sessions to the placeholder, and an MP3's
-- embedded album art is only rewritten when `embed-track-metadata` runs — so a
-- track tagged before that repoint still carries art whose cover row is gone.
-- Enqueue the reconciliation through the same `graphile_worker.add_job` seam the
-- app's own enqueue sites use; the job is marker-gated, so a track already in
-- sync costs two ranged reads and rewrites nothing. Guarded because the worker
-- installs its schema on first boot, which a fresh install has not reached.
DO $$
BEGIN
  IF to_regproc('graphile_worker.add_job') IS NULL THEN
    RETURN;
  END IF;
  PERFORM graphile_worker.add_job(
    'embed-track-metadata',
    payload => json_build_object('trackId', "stale"."id"),
    job_key => 'embed:' || "stale"."id"
  )
  FROM (
    SELECT DISTINCT "t"."id"
    FROM "tracks" AS "t"
    JOIN "generation_requests" AS "g" ON "g"."id" = "t"."generation_request_id"
    JOIN "activity_sessions" AS "s" ON "s"."id" = "g"."activity_session_id"
    JOIN "cover_images" AS "c" ON "c"."id" = "s"."cover_image_id"
    JOIN "track_audio_assets" AS "a"
      ON "a"."track_id" = "t"."id"
     AND "a"."asset_type" = 'local_original'
     AND "a"."storage_key" IS NOT NULL
     AND ("a"."mime_type" LIKE 'audio/mpeg%' OR "a"."storage_key" LIKE '%.mp3')
    WHERE "c"."source_type" = 'placeholder'
  ) AS "stale";
END $$;
