UPDATE "user_settings"
SET
  "value" = "value" || jsonb_build_object(
    'bufferEnabled', COALESCE("value" ->> 'bufferAheadTracks', '3') <> '0',
    'bufferAheadTracks', CASE "value" ->> 'bufferAheadTracks'
      WHEN '0' THEN 3
      ELSE COALESCE(("value" ->> 'bufferAheadTracks')::integer, 3)
    END
  ),
  "updated_at" = now()
WHERE "key" = 'generation';
