-- Persist the legacy generated-cover exhaustion verdict ONCE, at migration
-- time, so the runtime spend count is a pure read. A legacy cover is a
-- generated cover attributed to an owner that no ledger row claims; the set
-- only ever shrinks (new generated covers are always ledger-claimed), so
-- `true` is safe forever, and a fresh instance is `true` by construction.
-- `false` is deliberately permanent — those instances keep the (indexed)
-- windowed count.
INSERT INTO "app_settings" ("key", "value")
SELECT
  'legacyGeneratedCoversExhausted',
  to_jsonb(NOT EXISTS (
    SELECT 1
    FROM "cover_images" ci
    WHERE ci."source_type" = 'generated'
      AND ci."provenance" ->> 'ownerUserId' IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM "session_cover_generations" scg
        WHERE scg."owner_user_id" = ci."provenance" ->> 'ownerUserId'
          AND scg."cover_image_id" = ci."id"
      )
  ))
ON CONFLICT ("key") DO NOTHING;
