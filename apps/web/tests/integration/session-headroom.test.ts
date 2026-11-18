import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  updateMemberLimits,
  updateMembersPool,
  updateUsageLimits,
  userProfiles,
} from '@liedmotif/db';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { evaluateSessionHeadroom, headroomRefusalMessage } from '@/lib/sessions';

// The creation-time headroom gate, end-to-end against the DB. The
// pure `evaluateCreationHeadroom` decision is unit-tested in @liedmotif/shared and the
// e2e exercises the popup against a MOCKED 429; this fills the gap between them by
// driving the real money-gate the `POST /api/sessions` route calls: it reads the
// stored usage limits, counts the owner's spent tasks in the current windows, and
// resolves tracks-per-call from the (mock) music provider.
//
// Spend is counted in provider CALLS (tasks); the headroom threshold is expressed in
// TRACKS. The mock music provider yields 2 tracks/call, so N spent tasks burn
// `dailyGenerationTasks - N` tasks of daily headroom → `(…)*2` tracks.
const skip = !TEST_DATABASE_URL;

const NOW = new Date('2026-06-20T12:00:00Z'); // UTC reset windows: day ≥ 06-20, month ≥ 06-01

let testDb: TestDb;

/**
 * Configure the owner's usage limits. `monthlyGenerationTasks` is set far above the
 * daily cap so the DAILY window is always the binding constraint — these tests
 * exercise the daily gate, not the monthly one.
 */
async function seedLimits(limits: {
  daily: number;
  minHeadroom: number;
  trackCeiling?: boolean;
}): Promise<void> {
  await updateUsageLimits(testDb.db, {
    trackCeilingEnabled: limits.trackCeiling ?? true,
    dailyGenerationTasks: limits.daily,
    monthlyGenerationTasks: 400,
    minHeadroomTracksToStartSession: limits.minHeadroom,
    resetTimezone: 'UTC',
  });
}

/** Record `n` spent tasks (submitted provider jobs) for an owner at `createdAt`. */
async function seedSpentTasks(ownerUserId: string, n: number, createdAt: Date): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const generationRequestId = await createGenerationRequest(testDb.db, { ownerUserId });
    await createProviderJob(testDb.db, {
      generationRequestId,
      submitState: 'submitted',
      createdAt,
    });
  }
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('liedmotif-session-headroom-test');
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, GENERATION_FIXTURE_TABLES);
});

describe.skipIf(skip)('evaluateSessionHeadroom (creation-time money-gate)', () => {
  it('allows creation when the owner has ample headroom', async () => {
    await seedLimits({ daily: 40, minHeadroom: 5 });
    const ownerUserId = await createUser(testDb.db);

    // 40 daily tasks of headroom, none spent → 80 tracks, well over the 5-track floor.
    expect(await evaluateSessionHeadroom(testDb.db, ownerUserId, NOW)).toEqual({
      allowed: true,
      remainingTracks: 80,
      minHeadroomTracks: 5,
      scope: 'instance',
      window: 'day',
      windowCapTracks: 80,
    });
  });

  it('blocks creation when remaining headroom is below the configured threshold', async () => {
    await seedLimits({ daily: 3, minHeadroom: 5 });
    const ownerUserId = await createUser(testDb.db);
    await seedSpentTasks(ownerUserId, 2, NOW); // 1 task left → 2 tracks < 5

    expect(await evaluateSessionHeadroom(testDb.db, ownerUserId, NOW)).toEqual({
      allowed: false,
      remainingTracks: 2,
      minHeadroomTracks: 5,
      scope: 'instance',
      window: 'day',
      windowCapTracks: 6,
    });
  });

  it('blocks creation when the daily window is fully exhausted (0 remaining)', async () => {
    await seedLimits({ daily: 2, minHeadroom: 5 });
    const ownerUserId = await createUser(testDb.db);
    await seedSpentTasks(ownerUserId, 2, NOW); // daily cap reached → 0 tracks

    expect(await evaluateSessionHeadroom(testDb.db, ownerUserId, NOW)).toEqual({
      allowed: false,
      remainingTracks: 0,
      minHeadroomTracks: 5,
      scope: 'instance',
      window: 'day',
      windowCapTracks: 4,
    });
  });

  it('allows an Admin past the day cap to start a Session with the Track ceiling off', async () => {
    await seedLimits({ daily: 2, minHeadroom: 5, trackCeiling: false });
    const ownerUserId = await createUser(testDb.db);
    await seedSpentTasks(ownerUserId, 2, NOW);

    expect((await evaluateSessionHeadroom(testDb.db, ownerUserId, NOW)).allowed).toBe(true);
  });

  it("counts only the owner's own spend (per-owner isolation)", async () => {
    await seedLimits({ daily: 2, minHeadroom: 4 });
    const owner = await createUser(testDb.db);
    const other = await createUser(testDb.db);
    await seedSpentTasks(other, 5, NOW); // another user blows their budget...

    // ...which must not reduce this owner's headroom (2 tasks → 4 tracks ≥ 4).
    expect(await evaluateSessionHeadroom(testDb.db, owner, NOW)).toEqual({
      allowed: true,
      remainingTracks: 4,
      minHeadroomTracks: 4,
      scope: 'instance',
      window: 'day',
      windowCapTracks: 4,
    });
    // The over-spent owner is blocked on the same limits.
    expect((await evaluateSessionHeadroom(testDb.db, other, NOW)).allowed).toBe(false);
  });

  it('counts only spend inside the current window (yesterday does not block today)', async () => {
    await seedLimits({ daily: 1, minHeadroom: 2 });
    const ownerUserId = await createUser(testDb.db);
    // Spent before today's reset boundary: outside the daily window, so it does not
    // count against today's 1-task headroom.
    await seedSpentTasks(ownerUserId, 1, new Date('2026-06-19T23:00:00Z'));

    expect(await evaluateSessionHeadroom(testDb.db, ownerUserId, NOW)).toEqual({
      allowed: true,
      remainingTracks: 2,
      minHeadroomTracks: 2,
      scope: 'instance',
      window: 'day',
      windowCapTracks: 2,
    });
  });
});

describe.skipIf(skip)('evaluateSessionHeadroom — Member two-bound gate', () => {
  beforeEach(async () => {
    await truncateTables(testDb.pool, ['user_settings', 'app_settings']);
    await seedLimits({ daily: 40, minHeadroom: 5 });
  });

  async function seedMember(): Promise<string> {
    const memberId = await createUser(testDb.db);
    await testDb.db.insert(userProfiles).values({ userId: memberId, role: 'member' });
    return memberId;
  }

  it('blocks a member with personal headroom when the pool is exhausted, naming the shared budget', async () => {
    const other = await seedMember();
    await seedSpentTasks(other, 1, NOW);
    await updateMembersPool(testDb.db, { dailyGenerationTasks: 1, monthlyGenerationTasks: 10 });

    const memberId = await seedMember();
    expect(await evaluateSessionHeadroom(testDb.db, memberId, NOW)).toEqual({
      allowed: false,
      remainingTracks: 0,
      minHeadroomTracks: 5,
      scope: 'pool',
      window: 'day',
      windowCapTracks: 2,
    });
  });

  it('blocks a member whose own budget is spent while the pool is open, naming their budget', async () => {
    const memberId = await seedMember();
    await updateMemberLimits(testDb.db, {
      ownerUserId: memberId,
      patch: { dailyGenerationTasks: 1, monthlyGenerationTasks: 10 },
    });
    await seedSpentTasks(memberId, 1, NOW);

    expect(await evaluateSessionHeadroom(testDb.db, memberId, NOW)).toEqual({
      allowed: false,
      remainingTracks: 0,
      minHeadroomTracks: 5,
      scope: 'member',
      window: 'day',
      windowCapTracks: 2,
    });
  });

  it('names the member scope when both bounds are exhausted (personal budget takes precedence)', async () => {
    const memberId = await seedMember();
    await updateMemberLimits(testDb.db, {
      ownerUserId: memberId,
      patch: { dailyGenerationTasks: 1, monthlyGenerationTasks: 10 },
    });
    await updateMembersPool(testDb.db, { dailyGenerationTasks: 1, monthlyGenerationTasks: 10 });
    await seedSpentTasks(memberId, 1, NOW);

    const decision = await evaluateSessionHeadroom(testDb.db, memberId, NOW);
    expect(decision.allowed).toBe(false);
    expect(decision.scope).toBe('member');
  });

  it('allows a member when the tighter bound still clears the instance threshold', async () => {
    const memberId = await seedMember();
    const decision = await evaluateSessionHeadroom(testDb.db, memberId, NOW);
    // Member defaults: 10 tasks/day → 20 tracks; pool 40 → 80. Tighter = 20.
    expect(decision).toEqual({
      allowed: true,
      remainingTracks: 20,
      minHeadroomTracks: 5,
      scope: 'member',
      window: 'day',
      windowCapTracks: 20,
    });
  });

  it("names the admin's own instance bound, never a Member scope", async () => {
    const adminId = await createUser(testDb.db);
    await testDb.db.insert(userProfiles).values({ userId: adminId, role: 'admin' });
    expect(await evaluateSessionHeadroom(testDb.db, adminId, NOW)).toEqual({
      allowed: true,
      remainingTracks: 80,
      minHeadroomTracks: 5,
      scope: 'instance',
      window: 'day',
      windowCapTracks: 80,
    });
  });
});

// A One-time Member's headroom is total − used since the Grant; the
// threshold stays the instance value.
describe.skipIf(skip)('evaluateSessionHeadroom — One-time Member budget', () => {
  const GRANT = new Date('2026-06-10T00:00:00Z');

  async function seedOneTimeMember(totalGenerationTasks: number): Promise<string> {
    const memberId = await createUser(testDb.db);
    await testDb.db.insert(userProfiles).values({ userId: memberId, role: 'member' });
    await updateMemberLimits(testDb.db, {
      ownerUserId: memberId,
      patch: { kind: 'oneTime', totalGenerationTasks, grantedAt: GRANT.toISOString() },
    });
    return memberId;
  }

  it('gates on the remaining total, counting only spend since the Grant', async () => {
    await seedLimits({ daily: 40, minHeadroom: 5 });
    const memberId = await seedOneTimeMember(4);
    await seedSpentTasks(memberId, 2, NOW); // 2 of 4 used → 2 tasks → 4 tracks < 5
    await seedSpentTasks(memberId, 3, new Date('2026-06-01T12:00:00Z')); // before the Grant

    expect(await evaluateSessionHeadroom(testDb.db, memberId, NOW)).toEqual({
      allowed: false,
      remainingTracks: 4,
      minHeadroomTracks: 5,
      scope: 'member',
      window: 'total',
      windowCapTracks: 8,
    });
  });

  it('allows creation while the total has headroom', async () => {
    await seedLimits({ daily: 40, minHeadroom: 5 });
    const memberId = await seedOneTimeMember(4);
    await seedSpentTasks(memberId, 1, NOW); // 3 tasks left → 6 tracks ≥ 5

    expect((await evaluateSessionHeadroom(testDb.db, memberId, NOW)).allowed).toBe(true);
  });

  // The refusal the route answers with: a used-up total names the Admin (the
  // one person who can raise it), never a rollover; the Pool binding a One-time
  // Member reads as the shared budget, which does roll over.
  it('refuses a used-up total with "ask the Admin", by name', async () => {
    await seedLimits({ daily: 40, minHeadroom: 5 });
    const adminId = await createUser(testDb.db); // named 'Test Admin' by the fixture
    await testDb.db.insert(userProfiles).values({ userId: adminId, role: 'admin' });
    const memberId = await seedOneTimeMember(2);
    await seedSpentTasks(memberId, 2, NOW);

    const decision = await evaluateSessionHeadroom(testDb.db, memberId, NOW);
    expect(decision).toMatchObject({ allowed: false, scope: 'member', window: 'total' });
    expect(await headroomRefusalMessage(testDb.db, decision)).toBe(
      'Your budget is used up. Ask Test Admin for more. Resume one of your sessions from Sessions or play your Library instead.',
    );
  });

  it('refuses the Admin with the numbers and the reset in the Instance timezone', async () => {
    await seedLimits({ daily: 4, minHeadroom: 5 });
    const adminId = await createUser(testDb.db);
    await testDb.db.insert(userProfiles).values({ userId: adminId, role: 'admin' });
    await seedSpentTasks(adminId, 2, NOW); // 2 tasks left → 4 tracks < 5

    const decision = await evaluateSessionHeadroom(testDb.db, adminId, NOW);
    expect(await headroomRefusalMessage(testDb.db, decision)).toBe(
      'A new Session needs 5 Tracks; you have 4 left today. More Tracks at midnight (UTC). Resume one of your sessions from Sessions or play your Library instead.',
    );
  });

  it('refuses with the shared-budget copy when the total has headroom but the Pool is exhausted', async () => {
    await seedLimits({ daily: 40, minHeadroom: 5 });
    const other = await createUser(testDb.db);
    await testDb.db.insert(userProfiles).values({ userId: other, role: 'member' });
    // A Pool cap that fits a Session's 5 Tracks, used up: waiting for the reset helps.
    await seedSpentTasks(other, 3, NOW);
    await updateMembersPool(testDb.db, { dailyGenerationTasks: 3, monthlyGenerationTasks: 10 });
    const memberId = await seedOneTimeMember(10);

    const decision = await evaluateSessionHeadroom(testDb.db, memberId, NOW);
    expect(decision).toMatchObject({ allowed: false, scope: 'pool', window: 'day' });
    expect(await headroomRefusalMessage(testDb.db, decision)).toBe(
      'The shared budget is used up right now — new tracks resume when it resets. Resume one of your sessions from Sessions or play your Library instead.',
    );
  });
});
