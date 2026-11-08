-- The idle auto-stop window (`idleAutoStopAfterMinutes`) is at least 1 minute.
-- The active-Session sweep classifies every Session on it, and 0 would stop each
-- one, playing or not, on the next pass; the limits contract refuses it. A
-- stored 0 is lifted to the floor.
UPDATE "app_settings"
SET "value" = jsonb_set("value", '{idleAutoStopAfterMinutes}', '1'::jsonb),
    "updated_at" = now()
WHERE "key" = 'usageLimits'
  AND jsonb_typeof("value" -> 'idleAutoStopAfterMinutes') = 'number'
  AND ("value" ->> 'idleAutoStopAfterMinutes')::numeric < 1;
