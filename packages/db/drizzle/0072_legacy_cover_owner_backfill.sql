-- Backfill owner provenance on pre-provenance covers.
--
-- `cover_images` is instance-global and carries its owner in `provenance`;
-- every insert sets it, but rows written before provenance existed name nobody,
-- and the serving route grants an unattributed cover to no one. This restores
-- the owner for every such row an ownership pointer can name, so their owners
-- keep seeing their own covers.
--
-- Attribution comes from every pointer that already carries an owner: the
-- generation ledger, the session named in provenance, and the three tables that
-- wear a cover. A cover pointed at by two different owners is left alone —
-- guessing is worse than refusing. The placeholder is excluded by source type:
-- ownerless is what makes it instance-global.
WITH claims AS (
  SELECT "cover_image_id" AS id, "owner_user_id" AS owner FROM "session_cover_generations"
  UNION
  SELECT c."id", s."owner_user_id"
    FROM "cover_images" c
    JOIN "activity_sessions" s ON s."id"::text = c."provenance" ->> 'activitySessionId'
  UNION
  SELECT "cover_image_id", "owner_user_id" FROM "activity_sessions" WHERE "cover_image_id" IS NOT NULL
  UNION
  SELECT "cover_image_id", "owner_user_id" FROM "playlists" WHERE "cover_image_id" IS NOT NULL
  UNION
  SELECT "cover_image_id", "owner_user_id" FROM "tracks" WHERE "cover_image_id" IS NOT NULL
),
resolved AS (
  SELECT id, min(owner) AS owner FROM claims GROUP BY id HAVING count(DISTINCT owner) = 1
)
UPDATE "cover_images" c
SET "provenance" = coalesce(c."provenance", '{}'::jsonb) || jsonb_build_object('ownerUserId', r.owner)
FROM resolved r
WHERE r.id = c."id"
  AND c."source_type" <> 'placeholder'
  AND c."provenance" ->> 'ownerUserId' IS NULL;
