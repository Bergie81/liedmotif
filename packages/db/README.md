# `@liedmotif/db`

The Liedmotif data layer: the Drizzle schema, generated SQL migrations, the typed
client factory shared by web and worker, and transaction helpers. Consumed as
TypeScript source (no build step), matching the monorepo's source-first strategy.

> On top of the migration pipeline + committed Better Auth schema, this package
> defines the 15 Liedmotif application tables, their indexes/constraints, and
> seed support. Better Auth owns the auth tables; every app table references its
> `user.id`.

## Layout

```text
drizzle.config.ts      Drizzle Kit config (codebase-first; emits SQL into ./drizzle)
auth.config.ts         Generation-only Better Auth config (drives the CLI; NOT the runtime auth instance)
drizzle/               Generated, committed SQL migrations + metadata (drizzle-kit owns these)
src/
  schema/
    index.ts           Schema barrel Drizzle reads and the client binds (re-exports everything below)
    auth.ts            GENERATED + committed Better Auth tables (user/session/account/verification)
    enums.ts           Postgres enum types (the pinned state machines)
    types.ts           TypeScript shapes for jsonb columns (UsageLimits, EncryptedSecret, StyleSnapshot, …)
    _columns.ts        Internal reusable column builders (pk / timestamps / owner FKs)
    settings.ts        app_settings, admin_profile + the typed usage-limit defaults
    providers.ts       provider_credentials, usage_events
    taste.ts           taste_profiles
    covers.ts          cover_images
    generation.ts      generation_requests, provider_jobs
    tracks.ts          tracks, track_audio_assets
    sessions.ts        activity_sessions, activity_session_queue_items
    feedback.ts        feedback_events, playback_events
    deletion.ts        deletion_queue_items
    relations.ts       Drizzle relational-query relations (metadata only)
  client.ts            createDb (typed Drizzle client over a pg.Pool) + pingDb
  transactions.ts      withTransaction / withRetryableTransaction
  migrate.ts           Programmatic migration runner (exposed at `@liedmotif/db/migrate`)
  seed.ts              seedDatabase + DEFAULT_USAGE_LIMITS (exposed at `@liedmotif/db/seed`)
  index.ts             Public surface: pool factory + typed Drizzle layer
```

## Application schema

The 15 Liedmotif tables, by domain area. Every user-owned table carries
`ownerUserId` (or `userId` for the event logs) as a `text` FK to Better Auth's
`user.id`; app-table primary keys are random `uuid`s.

| Table | Owner FK | Notable foreign keys |
| --- | --- | --- |
| `app_settings` | — | (typed key/value; holds the `usageLimits` object) |
| `admin_profile` | `user_id` → `user.id` | 1:1 with the admin user |
| `provider_credentials` | `owner_user_id` → `user.id` *(nullable = instance-level)* | — |
| `usage_events` | `user_id` → `user.id` | — |
| `taste_profiles` | `owner_user_id` → `user.id` *(unique)* | — |
| `generation_requests` | `owner_user_id` → `user.id` | `activity_session_id` → `activity_sessions` |
| `provider_jobs` | — | `generation_request_id` → `generation_requests` *(unique)* |
| `tracks` | `owner_user_id` → `user.id` | `generation_request_id`, `provider_job_id`, `cover_image_id` |
| `track_audio_assets` | — | `track_id` → `tracks` |
| `cover_images` | — *(instance-global)* | — |
| `feedback_events` | `user_id` → `user.id` | `track_id`, `activity_session_id` |
| `activity_sessions` | `owner_user_id` → `user.id` | `current_track_id` → `tracks`, `current_queue_item_id` → queue items |
| `activity_session_queue_items` | — | `activity_session_id`, `track_id`, `generation_request_id` |
| `playback_events` | `owner_user_id` → `user.id` | `activity_session_id`, `queue_item_id`, `track_id` |
| `deletion_queue_items` | `owner_user_id` → `user.id` | `track_id` → `tracks` |

**Circular foreign keys.** `activity_sessions → tracks → generation_requests →
activity_sessions` (and `activity_sessions ↔ activity_session_queue_items`) form
cycles. They are broken with nullable columns plus Drizzle's documented
self/circular-reference pattern — the `AnyPgColumn` return-type annotation on the
lazy `.references()` callback. Drizzle Kit emits every FK as a post-`CREATE TABLE`
`ALTER TABLE ADD CONSTRAINT`, so the cycle applies cleanly; the nullable pointer
columns (`current_track_id`, `current_queue_item_id`, …) let an insert break the
cycle (create the session with null pointers, then back-fill).

**Enum vs text.** A value set becomes a Postgres enum (`pgEnum`, in `enums.ts`)
only when its values are pinned — the state-machine contract and the closed
lifecycle/discriminator sets (`track_status`,
`activity_session_status`, `queue_item_state`, `provider_normalized_status`,
`provider_submit_state`, `feedback_type`, …). Open vocabularies that grow with new
adapters or aren't pinned yet stay `text` to avoid an `ALTER TYPE` on every new
provider: `provider_key`, `usage_events.operation`,
`provider_credentials.validation_status`, `generation_requests.status`,
`storage_provider`, and `deletion_queue_items.reason`.

**Timestamps.** App tables use `timestamptz` (a deliberate departure from Better
Auth's plain `timestamp`): every app timestamp is an instant in time
(poll/retention/reset scheduling), and `timestamptz` avoids wall-clock ambiguity.

**Usage limits live in `app_settings`, not a table.** Global limits are a
single typed `UsageLimits` object under the `usageLimits` key
(`dailyGenerationTasks=40`, `monthlyGenerationTasks=400`, `maxConcurrentJobs=1`,
`maxQueuedTracks=6`, `maxSessionMinutesWithoutConfirmation=60`,
`maxRetriesPerJob=2`, `storageQuotaBytes=10 GiB`, `manualGenerationOnly=false`,
`idleAutoPauseAfterMinutes=15`, `resetTimezone=INSTANCE_TIMEZONE|UTC`). A Member's
personal budget is the `limits` key in `user_settings`.

### Key indexes and constraints

- **Partial unique** `activity_sessions_one_active_per_owner` on `owner_user_id`
  `WHERE status = 'active'` — at most one active session per owner.
- **Unique** `provider_jobs_generation_request_id_unique` — one paid provider task
  per generation request (money-idempotency).
- **Partial unique** `provider_jobs_provider_key_task_id_unique` on
  `(provider_key, provider_task_id) WHERE provider_task_id IS NOT NULL`.
- **Partial unique** `tracks_provider_key_track_id_unique` on
  `(provider_key, provider_track_id) WHERE provider_track_id IS NOT NULL`.
- B-tree indexes: tracks by owner/createdAt/savedAt/favoritedAt/status; generation
  requests by owner/activitySessionId/status; provider jobs by
  normalizedStatus/nextPollAt; queue items by (session, position) and state;
  playback events by (session, createdAt) and queueItemId; deletion queue via the
  partial `deletion_queue_items_due_idx (delete_after) WHERE processed_at IS NULL`
  (matches the worker's due scan; stays tiny while processed audit rows accumulate).

> The `tracks` provider column is named **`providerKey`** (matching
> `generation_requests` / `provider_jobs` and the uniqueness constraint on
> `(providerKey, providerTrackId)`) — the "which provider produced this" value.

## Seeding

`seedDatabase(db)` (and `npm run db:seed`) idempotently writes the default
`app_settings` (`usageLimits`) and the built-in placeholder cover row. Every
write is `onConflictDoNothing` keyed on a stable identity, so re-running never
duplicates rows or clobbers admin-tuned values. Exposed at the
`@liedmotif/db/seed` subpath (the setup wizard calls it).

```bash
DATABASE_URL=postgres://liedmotif:liedmotif@localhost:5433/liedmotif_dev npm run db:seed
```

## Not in the schema

These tables do not exist:

- **Per-user track state** — saved/favorite/disliked state lives on `tracks`
  (owner-scoped flags, with `savedAt`/`favoritedAt` denormalized from
  `playlist_tracks`) and in `feedback_events`.
- **Export bundles** — downloadable track/metadata archives.

## Migration order

Migrations are applied in a fixed order. Two systems own schema independently of
the Liedmotif app schema — Better Auth (its auth tables) and Graphile Worker (its
job-queue schema):

1. **Better Auth schema** — committed in the Drizzle schema (`src/schema/auth.ts`)
   and applied by Drizzle. Regenerate with `npm run auth:generate` whenever the
   Better Auth config changes; it overwrites `src/schema/auth.ts`.
2. **Liedmotif app migrations** — generated by Drizzle from `src/schema` and
   applied by Drizzle (`npm run db:generate` → `npm run db:migrate`). The auth
   migration establishes the pipeline; later migrations add the app tables.
3. **Graphile Worker schema** (`graphile_worker`) — owned by Graphile Worker, so
   it is installed/updated **separately** and explicitly (the worker does not
   self-install on boot): `npm run db:migrate:worker`.

A full bootstrap is therefore:

```bash
npm run db:migrate          # steps 1 + 2 (Drizzle: auth tables, then app tables)
npm run db:migrate:worker   # step 3 (graphile_worker schema)
npm run db:seed             # default app_settings (usage limits) + placeholder cover (idempotent)
```

## Scripts

Run from the repo root (each delegates into this workspace):

| Script | What it does |
| --- | --- |
| `npm run db:generate` | `drizzle-kit generate` — diff the schema, emit a new SQL migration into `drizzle/`. Offline; no DB needed. |
| `npm run db:migrate` | `drizzle-kit migrate` — apply pending migrations using `DATABASE_URL`. |
| `npm run db:seed` | Idempotently seed default `app_settings` (usage limits) + the placeholder cover using `DATABASE_URL`. |
| `npm run db:studio` | `drizzle-kit studio` — browse the database. |
| `npm run db:migrate:worker` | Install/update the `graphile_worker` schema (delegates to `@liedmotif/worker`). |
| `npm run auth:generate` | Regenerate `src/schema/auth.ts` via `@better-auth/cli generate`. |

`db:migrate` / `db:studio` need a reachable database; set `DATABASE_URL`, e.g.:

```bash
DATABASE_URL=postgres://liedmotif:liedmotif@localhost:5433/liedmotif_dev npm run db:migrate
```

## Typed client

Each process owns one `pg.Pool` and wraps it once:

```ts
import { createPool, createDb } from '@liedmotif/db';

const pool = createPool(process.env.DATABASE_URL!, { applicationName: 'liedmotif-web' });
const db = createDb(pool); // schema-typed Drizzle client
```

Web caches its pool + client on `globalThis` (`apps/web/lib/db.ts`); the worker
owns its own (`apps/worker/src/index.ts`). Web and worker are separate processes
and never share a pool.

Transaction helpers live alongside it: `withTransaction(db, fn)` and
`withRetryableTransaction(db, fn)` (bounded retry on serialization-failure /
deadlock — SQLSTATE `40001` / `40P01`).

## Test database

The migrate-from-clean integration test (`src/migrate.test.ts`) runs the
committed migrations against an **empty** database and asserts the Better Auth
tables exist. It needs a reachable Postgres via `TEST_DATABASE_URL` and is
**skipped** when that is unset (unit tests still run).

A dedicated, isolated Postgres ships in Docker Compose under the `test` profile:

```bash
npm run db:test:up      # docker compose --profile test up -d postgres-test  (host 127.0.0.1:5433)
TEST_DATABASE_URL=postgres://liedmotif:liedmotif@localhost:5433/liedmotif_test npm test
npm run db:test:down    # remove the test DB container and its volume (keeps no data)
```

The test resets the schema (`DROP SCHEMA public/drizzle … CREATE SCHEMA public`)
before each run, so migrations always apply from zero.
