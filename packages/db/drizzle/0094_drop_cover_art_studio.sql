-- Cover Art Studio drafts are discarded with their tables. A draft row is the
-- only reference to its image, so hand every live draft's key to the deletion
-- queue first; the recurring `process-deletion-queue` job reclaims the bytes
-- through the single path that owns file deletion. Both storage adapters treat
-- a missing object as already deleted, so a draft reserved but never stored is
-- safe to queue. Tombstoned drafts and drafts of a deleted batch had their keys
-- queued when they were deleted.
INSERT INTO "deletion_queue_items" ("owner_user_id", "storage_key", "reason", "delete_after")
SELECT "c"."owner_user_id", "c"."storage_key", 'cover_art_studio_removed', now()
FROM "cover_art_studio_candidates" AS "c"
JOIN "cover_art_studio_batches" AS "b"
  ON "b"."id" = "c"."batch_id"
WHERE "c"."deleted_at" IS NULL AND "b"."deleted_at" IS NULL;--> statement-breakpoint
-- A queued or retrying batch job would name a task no worker registers. Guarded
-- because the worker installs its schema on first boot, which a fresh install
-- has not reached.
DO $$
BEGIN
  IF to_regclass('graphile_worker._private_jobs') IS NULL
     OR to_regclass('graphile_worker._private_tasks') IS NULL THEN
    RETURN;
  END IF;
  DELETE FROM graphile_worker._private_jobs
  WHERE task_id IN (
    SELECT id FROM graphile_worker._private_tasks
    WHERE identifier = 'generate-cover-art-studio-batch'
  );
END $$;--> statement-breakpoint
DROP TABLE "cover_art_studio_candidates" CASCADE;--> statement-breakpoint
DROP TABLE "cover_art_studio_batches" CASCADE;--> statement-breakpoint
DROP TYPE "public"."cover_art_studio_batch_state";--> statement-breakpoint
DROP TYPE "public"."cover_art_studio_candidate_state";
