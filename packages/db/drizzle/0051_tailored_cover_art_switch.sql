-- The cover switch selects a SOURCE rather than switching Covers off.
-- `usageLimits` is a JSON blob, so the rename needs no schema change — but it does need a VALUE backfill: without one an instance
-- that stored `coverGenerationEnabled: false` reads the absent
-- `tailoredCoverArtEnabled` as its default `true` and silently resumes paying
-- the image provider. Carry the old intent across and drop the dead keys.
--
-- An explicit `tailoredCoverArtEnabled` already written by the new code wins, so
-- applying this after the app has run cannot undo a choice made since.
UPDATE "app_settings"
SET "value" =
      ("value" - 'coverGenerationEnabled' - 'sunoCoverGenerationEnabled')
      || jsonb_build_object(
           'tailoredCoverArtEnabled',
           COALESCE(
             "value" -> 'tailoredCoverArtEnabled',
             "value" -> 'coverGenerationEnabled',
             'true'::jsonb
           )
         ),
    "updated_at" = now()
WHERE "key" = 'usageLimits'
  AND ("value" ? 'coverGenerationEnabled' OR "value" ? 'sunoCoverGenerationEnabled');
