-- Repair Tracks created from an early provider stream before the later final
-- result supplied its duration. Prefer the downloaded local original when it
-- recorded a length, then fall back to the provider final asset.
UPDATE "tracks" AS "track"
SET
	"duration_seconds" = (
		SELECT "asset"."duration_seconds"
		FROM "track_audio_assets" AS "asset"
		WHERE
			"asset"."track_id" = "track"."id"
			AND "asset"."duration_seconds" IS NOT NULL
			AND "asset"."asset_type" IN ('local_original', 'provider_final')
		ORDER BY CASE "asset"."asset_type"
			WHEN 'local_original' THEN 0
			ELSE 1
		END
		LIMIT 1
	),
	"updated_at" = now()
WHERE
	"track"."duration_seconds" IS NULL
	AND EXISTS (
		SELECT 1
		FROM "track_audio_assets" AS "asset"
		WHERE
			"asset"."track_id" = "track"."id"
			AND "asset"."duration_seconds" IS NOT NULL
			AND "asset"."asset_type" IN ('local_original', 'provider_final')
	);
