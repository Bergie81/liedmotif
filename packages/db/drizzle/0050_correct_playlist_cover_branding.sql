UPDATE "cover_images"
SET "provenance" = jsonb_set("provenance", '{branded}', 'false'::jsonb)
WHERE "source_type" = 'generated'
  AND "provenance" ? 'playlistId'
  AND "provenance" -> 'branded' IS DISTINCT FROM 'false'::jsonb;
