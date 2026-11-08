-- Retype `title_seed` text → integer (it stores the request's zero-based index
-- within its session; it was never written as anything but stringified integers,
-- and is null everywhere in released databases). Postgres needs the explicit
-- USING cast — drizzle-kit emits the ALTER without one.
ALTER TABLE "generation_requests" ALTER COLUMN "title_seed" SET DATA TYPE integer USING "title_seed"::integer;
