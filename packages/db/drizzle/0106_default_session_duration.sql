-- The Buffer switch gives way to the Default Session duration. A switched-off
-- Buffer meant new Sessions spent as little as possible, which the 5 min default
-- now gives; a switched-on one stores no duration and reads the shipped default.
UPDATE "user_settings"
SET
  "value" = ("value" - 'bufferEnabled') || CASE
    WHEN ("value" ->> 'bufferEnabled')::boolean IS FALSE
      THEN '{"defaultSessionDurationMinutes": 5}'::jsonb
    ELSE '{}'::jsonb
  END,
  "updated_at" = now()
WHERE "key" = 'generation'
  AND "value" ? 'bufferEnabled';
