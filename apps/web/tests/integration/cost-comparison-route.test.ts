// Admin cost comparison: the Admin-only aggregate read behind the
// Costs tab of Your Stats — own, Members and Former members, counted by the
// budget accounting's own possibly-paid predicates on the instance budget
// calendar, and never carrying anyone's content.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createUser,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import {
  deleteMember,
  sessionCoverGenerations,
  updateUnitCosts,
  updateUsageLimits,
  user,
  userProfiles,
} from '@liedmotif/db';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  adminId: null as string | null,
  viewerIsAdmin: true,
  now: new Date('2026-06-29T12:00:00Z'),
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.viewerIsAdmin ? { user: { id: holder.adminId } } : null),
  getAppSession: async () => ({ user: { id: 'member-viewer' } }),
}));
vi.mock('@/lib/providers/providers', () => ({ getTypicalTracksPerMusicRequest: () => 2 }));

const { GET } = await import('@/app/api/settings/cost-comparison/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

async function read(range?: string) {
  const query = range ? `?range=${range}` : '';
  return GET(new Request(`http://localhost/api/settings/cost-comparison${query}`));
}

async function readData(range?: string) {
  const res = await read(range);
  expect(res.status).toBe(200);
  return (await res.json()).data;
}

async function createNamedUser(name: string): Promise<string> {
  const userId = await createUser(testDb.db);
  await testDb.db.update(user).set({ name }).where(eq(user.id, userId));
  return userId;
}

async function createMember(name: string): Promise<string> {
  const userId = await createNamedUser(name);
  await testDb.db.insert(userProfiles).values({ userId, role: 'member' });
  return userId;
}

/** One music-model call for `ownerUserId`, in whatever submit state it parked in. */
async function spendTask(
  ownerUserId: string,
  createdAt: Date,
  submitState: 'submitted' | 'submit_unknown' | 'submit_rejected' = 'submitted',
): Promise<void> {
  const generationRequestId = await createGenerationRequest(testDb.db, {
    ownerUserId,
    createdAt,
    userPrompt: 'a private prompt',
  });
  await createProviderJob(testDb.db, { generationRequestId, createdAt, submitState });
}

/** One generated-Cover attempt: possibly paid unless it failed before the provider. */
async function spendCover(ownerUserId: string, at: Date, possiblyPaid = true): Promise<void> {
  const id = randomUUID();
  await testDb.db.insert(sessionCoverGenerations).values({
    id,
    ownerUserId,
    activitySessionId: null,
    state: possiblyPaid ? 'quality_rejected' : 'provider_unavailable',
    possiblyPaid,
    submittedAt: possiblyPaid ? at : null,
    plan: { prompt: 'a private cover prompt', sessionName: 'A private title' } as never,
    planVersion: 'test-plan',
    promptVersion: 'test-prompt',
    planHash: `plan-${id}`,
    promptHash: `prompt-${id}`,
    fingerprint: {},
    providerKey: 'test-provider',
    model: 'test-model',
    capabilitySnapshot: {},
    idempotencyKey: `cover-${id}`,
    retryPolicy: { version: 'test' },
    coverImageId: randomUUID(),
    storageKey: `covers/${id}.webp`,
    createdAt: at,
  });
}

const RECENT = new Date('2026-06-28T12:00:00Z');

describe.skipIf(skip)('admin cost comparison route', () => {
  beforeAll(async () => {
    testDb = await connectTestDb('cost-comparison-route-test');
    holder.db = testDb.db;
  }, 60_000);
  afterAll(async () => {
    await testDb?.pool.end();
  });
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: holder.now });
    await truncateTables(testDb.pool, [
      'session_cover_generations',
      'cover_images',
      'app_settings',
      'provider_jobs',
      'generation_requests',
      'user',
    ]);
    holder.viewerIsAdmin = true;
    holder.adminId = await createNamedUser('John');
    await testDb.db.insert(userProfiles).values({ userId: holder.adminId, role: 'admin' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses a Member', async () => {
    holder.viewerIsAdmin = false;
    expect((await read()).status).toBe(401);
  });

  it('compares own, combined and per-Member spend in Tracks and Covers', async () => {
    const lisa = await createMember('Lisa');
    const omar = await createMember('Omar');
    await spendTask(holder.adminId!, RECENT);
    await spendTask(lisa, RECENT);
    await spendTask(lisa, RECENT);
    await spendCover(lisa, RECENT);
    await spendCover(holder.adminId!, RECENT);
    await spendCover(holder.adminId!, RECENT);

    const data = await readData();
    expect(data.range).toBe('30d');
    expect(data.own).toEqual({ tracks: 2, covers: 2 });
    expect(data.members).toEqual({ tracks: 4, covers: 1 });
    expect(data.total).toEqual({ tracks: 6, covers: 3 });
    expect(data.perMember).toEqual([
      { userId: lisa, name: 'Lisa', tracks: 4, covers: 1 },
      { userId: omar, name: 'Omar', tracks: 0, covers: 0 },
    ]);
    expect(data.formerMembers).toEqual({ tracks: 0, covers: 0 });
  });

  it('counts uncertain attempts as spend and leaves refusals and unpaid Cover failures out', async () => {
    const lisa = await createMember('Lisa');
    await spendTask(lisa, RECENT, 'submit_unknown');
    await spendTask(lisa, RECENT, 'submit_rejected');
    await spendCover(lisa, RECENT);
    await spendCover(lisa, RECENT, false);

    expect((await readData()).members).toEqual({ tracks: 2, covers: 1 });
  });

  it('keeps a deleted Member’s music spend under Former members, and the total reconciles', async () => {
    const lisa = await createMember('Lisa');
    const omar = await createMember('Omar');
    await spendTask(holder.adminId!, RECENT);
    await spendTask(lisa, RECENT);
    await spendTask(omar, RECENT);
    await spendTask(omar, RECENT);
    const before = await readData();
    expect((await deleteMember(testDb.db, { userId: omar })).ok).toBe(true);

    const data = await readData();
    expect(data.formerMembers).toEqual({ tracks: 4, covers: 0 });
    expect(data.perMember.map((row: { name: string }) => row.name)).toEqual(['Lisa']);
    expect(data.members).toEqual({ tracks: 6, covers: 0 });
    expect(data.total).toEqual(before.total);
    expect(data.total.tracks).toBe(
      data.own.tracks +
        data.formerMembers.tracks +
        data.perMember.reduce((sum: number, row: { tracks: number }) => sum + row.tracks, 0),
    );
  });

  it('carries the current prices, so an edit reprices the same history', async () => {
    await spendTask(holder.adminId!, RECENT);
    await updateUnitCosts(testDb.db, { perTrackUsd: 0.05, perCoverUsd: 0 });
    const cheap = await readData();
    await updateUnitCosts(testDb.db, { perTrackUsd: 0.5 });
    const dear = await readData();

    expect(cheap.unitCosts).toEqual({ perTrackUsd: 0.05, perCoverUsd: 0 });
    expect(dear.unitCosts).toEqual({ perTrackUsd: 0.5, perCoverUsd: 0 });
    expect(dear.own).toEqual(cheap.own);
  });

  it('cuts periods at midnight in the instance budget timezone', async () => {
    await updateUsageLimits(testDb.db, { resetTimezone: 'Pacific/Auckland' });
    // Noon UTC on 29 June is 30 June in Auckland (UTC+12): the 7-day range opens
    // at local midnight 24 June, which is 23 June 12:00 UTC.
    await spendTask(holder.adminId!, new Date('2026-06-23T11:59:00Z'));
    await spendTask(holder.adminId!, new Date('2026-06-23T12:00:00Z'));

    const week = await readData('7d');
    expect(week.timezone).toBe('Pacific/Auckland');
    expect(week.from).toBe('2026-06-23T12:00:00.000Z');
    expect(week.own.tracks).toBe(2);
    expect((await readData('all')).own.tracks).toBe(4);
    expect((await readData('all')).from).toBeNull();
  });

  it('returns aggregates only — no content of anyone’s', async () => {
    const lisa = await createMember('Lisa');
    await spendTask(lisa, RECENT);
    await spendCover(lisa, RECENT);

    const data = await readData();
    expect(Object.keys(data).sort()).toEqual([
      'formerMembers',
      'from',
      'members',
      'own',
      'perMember',
      'range',
      'timezone',
      'total',
      'unitCosts',
    ]);
    expect(Object.keys(data.perMember[0]).sort()).toEqual(['covers', 'name', 'tracks', 'userId']);
    expect(JSON.stringify(data)).not.toContain('private');
  });

  it('rejects an unknown range', async () => {
    expect((await read('1y')).status).toBe(400);
  });
});
