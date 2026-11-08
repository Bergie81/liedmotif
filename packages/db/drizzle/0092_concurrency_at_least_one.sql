-- Generating at once (`maxConcurrentJobs`) is at least 1 provider call. At 0 no
-- call can start, so a Session waits for its first Track forever and nothing
-- says why; the limit contracts refuse it, and a Track budget of 0 is the way to
-- stop generation. A stored 0 is lifted to the floor wherever a budget lives: the
-- instance limits, each Member budget, the Members Pool, and a pending invite's
-- budget, which its claim copies into the Member's limits unvalidated. A Member
-- budget or the Pool is re-validated as `stored || patch`, so a surviving 0 would
-- fail every later edit of it.
UPDATE "app_settings"
SET "value" = jsonb_set("value", '{maxConcurrentJobs}', '1'::jsonb),
    "updated_at" = now()
WHERE "key" IN ('usageLimits', 'memberPool')
  AND jsonb_typeof("value" -> 'maxConcurrentJobs') = 'number'
  AND ("value" ->> 'maxConcurrentJobs')::numeric < 1;--> statement-breakpoint
UPDATE "user_settings"
SET "value" = jsonb_set("value", '{maxConcurrentJobs}', '1'::jsonb),
    "updated_at" = now()
WHERE "key" = 'limits'
  AND jsonb_typeof("value" -> 'maxConcurrentJobs') = 'number'
  AND ("value" ->> 'maxConcurrentJobs')::numeric < 1;--> statement-breakpoint
UPDATE "invites"
SET "budget" = jsonb_set("budget", '{maxConcurrentJobs}', '1'::jsonb)
WHERE "consumed_at" IS NULL
  AND jsonb_typeof("budget" -> 'maxConcurrentJobs') = 'number'
  AND ("budget" ->> 'maxConcurrentJobs')::numeric < 1;
