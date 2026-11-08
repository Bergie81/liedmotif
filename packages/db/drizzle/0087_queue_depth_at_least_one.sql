-- A queue depth (`maxQueuedTracks`) is at least 1 Track. 0 would only zero the
-- Buffer watermark while revision fills and Dislike rerolls still generate, so it
-- cannot mean "nothing queued", and the limit contracts refuse it. A stored 0 is
-- lifted to the floor: a Member budget is re-validated as `stored || patch`, so a
-- surviving 0 would fail every later edit of that budget.
UPDATE "app_settings"
SET "value" = jsonb_set("value", '{maxQueuedTracks}', '1'::jsonb),
    "updated_at" = now()
WHERE "key" = 'usageLimits'
  AND jsonb_typeof("value" -> 'maxQueuedTracks') = 'number'
  AND ("value" ->> 'maxQueuedTracks')::numeric < 1;--> statement-breakpoint
UPDATE "user_settings"
SET "value" = jsonb_set("value", '{maxQueuedTracks}', '1'::jsonb),
    "updated_at" = now()
WHERE "key" = 'limits'
  AND jsonb_typeof("value" -> 'maxQueuedTracks') = 'number'
  AND ("value" ->> 'maxQueuedTracks')::numeric < 1;
