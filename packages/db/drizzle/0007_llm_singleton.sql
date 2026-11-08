-- Single-LLM invariant: the instance runs at most ONE text LLM, so
-- owner-less `llm` credential rows become a DB-enforced singleton. First clean up
-- any pre-invariant duplicates deterministically — keep the most recently updated
-- row (matching `configuredLlmKey()`'s `updatedAt DESC` fallback), with `id` as
-- the extra tie-breaker this one-shot dedup needs for exact ties.
DELETE FROM "provider_credentials" a
USING "provider_credentials" b
WHERE a.owner_user_id IS NULL
  AND b.owner_user_id IS NULL
  AND a.provider_type = 'llm'
  AND b.provider_type = 'llm'
  AND a.id <> b.id
  AND (a.updated_at, a.id) < (b.updated_at, b.id);--> statement-breakpoint
CREATE UNIQUE INDEX "provider_credentials_instance_llm_singleton" ON "provider_credentials" USING btree ("provider_type") WHERE "provider_credentials"."owner_user_id" is null and "provider_credentials"."provider_type" = 'llm';
