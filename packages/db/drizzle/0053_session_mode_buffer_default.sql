-- `bufferEnabled` becomes the DEFAULT Session mode for new sessions instead of a
-- generation blocker: a `keep_going` session now tops up regardless of it. Align
-- existing sessions of buffer-off owners with the behavior they observed (no
-- automatic top-ups) by moving them to `repeat` — otherwise resuming any of them
-- would silently start spending.
UPDATE "activity_sessions"
SET "session_mode" = 'repeat'
WHERE "session_mode" = 'keep_going'
  AND "owner_user_id" IN (
    SELECT "owner_user_id"
    FROM "user_settings"
    WHERE "key" = 'generation'
      AND ("value" ->> 'bufferEnabled')::boolean IS FALSE
  );
