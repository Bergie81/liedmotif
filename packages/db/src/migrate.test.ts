import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_SETTINGS_KEYS,
  activitySessions,
  appSettings,
  createDb,
  createPool,
  generationRequests,
  providerJobs,
  user,
  type Database,
  type Pool,
} from './index';
import { runDrizzleMigrations } from './migrate';
import { seedDatabase } from './seed';

// Integration test: run the committed migrations against a CLEAN database and
// assert both Better Auth's tables and the Liedmotif application tables exist,
// along with the key constraints. Requires a reachable test Postgres via
// `TEST_DATABASE_URL` (see `.env.example` / `npm run db:test:up`); skipped when
// unset so the unit suite stays green without a database.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

const AUTH_TABLES = ['user', 'session', 'account', 'verification'] as const;

/** Every Liedmotif application table the migrations must create. */
const APP_TABLES = [
  'app_settings',
  'user_settings',
  'session_loop_leases',
  'user_profiles',
  'listener_profiles',
  'provider_credentials',
  'usage_events',
  'taste_profiles',
  'generation_requests',
  'provider_jobs',
  'tracks',
  'track_audio_assets',
  'cover_images',
  'session_cover_generations',
  'feedback_events',
  'activity_sessions',
  'activity_session_queue_items',
  'playback_events',
  'deletion_queue_items',
] as const;

/** Unique indexes the schema's invariants depend on. */
const UNIQUE_INDEXES = [
  'activity_sessions_one_active_per_owner',
  'provider_jobs_generation_request_id_unique',
  'provider_jobs_provider_key_task_id_unique',
  'tracks_provider_key_track_id_unique',
  // Single-admin invariant + one instance credential per provider.
  'user_profiles_single_admin',
  'provider_credentials_instance_provider_unique',
  // One settings row per (owner, key).
  'user_settings_owner_key_unique',
  'activity_sessions_owner_id_unique',
  // At most one LIVE attempt per session;
  // terminal attempts accumulate as the session's cover history.
  'session_cover_generations_owner_session_live_unique',
  'session_cover_generations_cover_id_unique',
  'session_cover_generations_storage_key_unique',
  'session_cover_generations_idempotency_key_unique',
] as const;

const UNIQUE_VIOLATION = '23505';

/** Pull the database name (URL path, minus the leading slash) out of a connection string. */
function databaseNameOf(url: string): string | undefined {
  try {
    const name = new URL(url).pathname.replace(/^\//, '');
    return name || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Refuse to run the destructive schema reset against anything that does not look
 * like a throwaway test database. `beforeAll` below DROPs whole schemas, so a
 * misconfigured `TEST_DATABASE_URL` aimed at a real database would be
 * catastrophic. Belt-and-suspenders, all checked BEFORE any DROP: the var must
 * be set, it must differ from the runtime `DATABASE_URL`, and the target
 * database name must look like a test database (contain "test").
 */
function assertSafeTestDatabase(url: string | undefined): asserts url is string {
  if (!url) {
    throw new Error('TEST_DATABASE_URL must be set to run the destructive migrate-from-clean test');
  }
  if (process.env.DATABASE_URL && url === process.env.DATABASE_URL) {
    throw new Error(
      'Refusing destructive schema reset: TEST_DATABASE_URL must not equal DATABASE_URL',
    );
  }
  const databaseName = databaseNameOf(url);
  if (!databaseName || !databaseName.toLowerCase().includes('test')) {
    throw new Error(
      `Refusing destructive schema reset: target database "${databaseName ?? '(unparseable)'}" ` +
        'does not look like a test database (its name must contain "test")',
    );
  }
}

/** Find the Postgres SQLSTATE on an error or anywhere in its `cause` chain. */
function pgErrorCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Resolve the rejection of `promise` and assert it is a Postgres error with
 * SQLSTATE `code`. Drizzle wraps the driver error, so the code is read off the
 * whole `cause` chain, not just the top-level object.
 */
async function expectPgErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown, 'expected the insert to be rejected').toBeDefined();
  expect(pgErrorCode(thrown)).toBe(code);
}

describeIfDb('drizzle migrations against a clean database', () => {
  let pool: Pool;
  let db: Database;

  beforeAll(async () => {
    // Hard safety gate: never DROP against a database that isn't an obvious
    // throwaway test target. Runs before the pool is even opened.
    assertSafeTestDatabase(testDatabaseUrl);
    pool = createPool(testDatabaseUrl, { applicationName: 'liedmotif-db-test', max: 2 });
    db = createDb(pool);
    // Reset to a pristine state: drop the app schema and Drizzle's migration
    // bookkeeping schema, then recreate `public`. Guarantees migrations run from
    // zero every time.
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await pool.query('CREATE SCHEMA public');
    await runDrizzleMigrations(db);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it('creates every Better Auth table', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const tableNames = new Set(rows.map((row) => row.table_name));
    for (const table of AUTH_TABLES) {
      expect(tableNames.has(table)).toBe(true);
    }
  });

  it('creates every Liedmotif application table', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const tableNames = new Set(rows.map((row) => row.table_name));
    for (const table of APP_TABLES) {
      expect(tableNames, `missing table ${table}`).toContain(table);
    }
  });

  it('records the migration as applied in drizzle bookkeeping', async () => {
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations',
    );
    // Both the auth migration (0000) and the app-tables migration (0001).
    expect(Number(rows[0]?.count ?? '0')).toBeGreaterThanOrEqual(2);
  });

  it('enforces the user.email unique constraint from the migration', async () => {
    const { rows } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'user_email_unique'
       ) AS exists`,
    );
    expect(rows[0]?.exists).toBe(true);
  });

  it('creates the documented unique indexes (incl. the partial ones)', async () => {
    const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const byName = new Map(rows.map((row) => [row.indexname, row.indexdef] as const));
    for (const name of UNIQUE_INDEXES) {
      const def = byName.get(name);
      expect(def, `missing unique index ${name}`).toBeDefined();
      expect(def).toContain('UNIQUE INDEX');
    }
    // The active-session and provider-task indexes must be PARTIAL (have a WHERE).
    expect(byName.get('activity_sessions_one_active_per_owner')).toContain('WHERE');
    expect(byName.get('activity_sessions_one_active_per_owner')).toContain("status = 'active'");
    expect(byName.get('provider_jobs_provider_key_task_id_unique')).toContain('WHERE');
  });

  it('enforces at most one active session per owner (partial unique)', async () => {
    const ownerId = 'owner-active-session';
    await db
      .insert(user)
      .values({ id: ownerId, name: 'Active Owner', email: 'active-owner@example.test' });

    // First active session is fine.
    await db.insert(activitySessions).values({ ownerUserId: ownerId });
    // Second active session for the same owner violates the partial unique index.
    await expectPgErrorCode(
      db.insert(activitySessions).values({ ownerUserId: ownerId }),
      UNIQUE_VIOLATION,
    );
    // A non-active session for the same owner is allowed (outside the predicate).
    await db.insert(activitySessions).values({ ownerUserId: ownerId, status: 'stopped' });
  });

  it('enforces one provider job per generation request (unique)', async () => {
    const ownerId = 'owner-provider-job';
    await db
      .insert(user)
      .values({ id: ownerId, name: 'Job Owner', email: 'job-owner@example.test' });

    const [request] = await db
      .insert(generationRequests)
      .values({
        ownerUserId: ownerId,
        source: 'controls',
        providerType: 'music',
        providerKey: 'suno',
        status: 'submitting',
      })
      .returning({ id: generationRequests.id });
    const generationRequestId = request?.id;
    expect(generationRequestId).toBeDefined();

    // One paid provider job per request is allowed.
    await db.insert(providerJobs).values({
      generationRequestId: generationRequestId!,
      providerType: 'music',
      providerKey: 'suno',
    });
    // A second job for the same request must be rejected (money-idempotency).
    await expectPgErrorCode(
      db.insert(providerJobs).values({
        generationRequestId: generationRequestId!,
        providerType: 'music',
        providerKey: 'suno',
      }),
      UNIQUE_VIOLATION,
    );
  });

  it('seeds default app settings idempotently', async () => {
    // Seed twice: the second run must not error or duplicate the row.
    await seedDatabase(db);
    await seedDatabase(db);

    const settings = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, APP_SETTINGS_KEYS.usageLimits));
    expect(settings).toHaveLength(1);

    const limits = settings[0]?.value as Record<string, unknown> | undefined;
    expect(limits?.dailyGenerationTasks).toBe(25);
    expect(limits?.monthlyGenerationTasks).toBe(125);
    expect(limits?.maxConcurrentJobs).toBe(1);
    expect(limits?.maxQueuedTracks).toBe(6);
    expect(limits?.storageQuotaBytes).toBe(10 * 1024 * 1024 * 1024);
    expect(limits?.manualGenerationOnly).toBe(false);
  });
});
