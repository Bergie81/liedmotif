-- A pending Member invite carries the budget its claim copies into the new
-- Member's `user_settings.limits` unvalidated, so the queue-depth floor of 1
-- (0087) holds for it too.
UPDATE "invites"
SET "budget" = jsonb_set("budget", '{maxQueuedTracks}', '1'::jsonb)
WHERE "consumed_at" IS NULL
  AND jsonb_typeof("budget" -> 'maxQueuedTracks') = 'number'
  AND ("budget" ->> 'maxQueuedTracks')::numeric < 1;
