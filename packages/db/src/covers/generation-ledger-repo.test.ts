import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPlaylist } from '../playlists/playlists-repo';
import { sessionCoverGenerations, type SessionCoverPlanRecord } from '../schema';
import {
  connectTestDb,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '../testing';
import {
  getLatestCoverAccountOutcome,
  getLiveSessionCoverGeneration,
  getSessionCoverGeneration,
  listAgedSessionCoverGenerationIds,
  listRecentSessionCoverGenerations,
  planSessionCoverGeneration,
} from './generation-ledger-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const RECOVERY_PLAN: SessionCoverPlanRecord = {
  sessionName: 'Recovery fixture',
  coverConcept: null,
  selectedStyle: 'auto',
  resolvedStyle: 'minimal',
  customDefinition: null,
  styleFallbackReason: null,
  concreteScene: 'one paper moon',
  semanticCueIds: ['title:moon'],
  conceptMode: 'title symbol',
  subjectFamily: 'symbol',
  composition: 'centered',
  palette: 'blue',
  material: 'paper',
  lighting: 'soft',
  referenceTreatment: null,
  prompt: 'fixture',
  exclusions: [],
  altText: 'Recovery fixture cover',
  candidateCount: 1,
};

const HISTORY_PLAN: SessionCoverPlanRecord = {
  sessionName: 'History fixture',
  coverConcept: null,
  selectedStyle: 'minimal',
  resolvedStyle: 'minimal',
  customDefinition: null,
  styleFallbackReason: null,
  concreteScene: 'one controlled scene',
  semanticCueIds: ['name:exact'],
  conceptMode: 'title symbol',
  subjectFamily: 'one controlled subject',
  composition: 'one controlled composition',
  palette: 'one controlled palette',
  material: 'one controlled material',
  lighting: 'one controlled light',
  referenceTreatment: null,
  prompt: 'private prompt',
  exclusions: [],
  altText: 'History fixture',
  candidateCount: 12,
  diversityRelaxedAxes: [],
};

describeIfDb('Session Cover recovery ledger query', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-session-cover-ledger-recovery-test');
  }, 60_000);

  afterAll(async () => ctx?.pool.end());

  beforeEach(async () => truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES));

  it('returns only live operations older than the recovery cutoff, Playlist attempts included', async () => {
    const ownerUserId = await createUser(ctx.db);
    const agedSessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
    const freshSessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
    const terminalSessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
    const agedPlaylist = await createPlaylist(ctx.db, { ownerUserId, name: 'Aged' });
    const insert = async (
      subject: { activitySessionId: string } | { playlistId: string },
      state: 'reserved' | 'planned' | 'submitting' | 'provider_rejected',
      updatedAt: Date,
      trigger: 'initial' | 'user_regenerate' = 'initial',
    ) => {
      const id = randomUUID();
      await ctx.db.insert(sessionCoverGenerations).values({
        id,
        ownerUserId,
        ...subject,
        trigger,
        state,
        plan: RECOVERY_PLAN,
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
        updatedAt,
      });
      return id;
    };
    const agedId = await insert(
      { activitySessionId: agedSessionId },
      'planned',
      new Date('2026-07-12T11:00:00.000Z'),
    );
    await insert(
      { activitySessionId: freshSessionId },
      'submitting',
      new Date('2026-07-12T11:59:00.000Z'),
    );
    await insert(
      { activitySessionId: terminalSessionId },
      'provider_rejected',
      new Date('2026-07-12T10:00:00.000Z'),
    );
    // A Playlist regeneration whose job never ran: only this scan can settle it.
    const agedPlaylistAttemptId = await insert(
      { playlistId: agedPlaylist.id },
      'reserved',
      new Date('2026-07-12T11:10:00.000Z'),
      'user_regenerate',
    );

    await expect(
      listAgedSessionCoverGenerationIds(ctx.db, {
        updatedBefore: new Date('2026-07-12T11:50:00.000Z'),
        limit: 25,
      }),
    ).resolves.toEqual([
      {
        id: agedId,
        ownerUserId,
        activitySessionId: agedSessionId,
        playlistId: null,
        trigger: 'initial',
      },
      {
        id: agedPlaylistAttemptId,
        ownerUserId,
        activitySessionId: null,
        playlistId: agedPlaylist.id,
        trigger: 'user_regenerate',
      },
    ]);
  });
});

describeIfDb('Session Cover multi-attempt ledger', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-session-cover-ledger-attempts-test');
  }, 60_000);

  afterAll(async () => ctx?.pool.end());

  beforeEach(async () => truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES));

  function attemptInput(args: {
    ownerUserId: string;
    activitySessionId: string;
    initialState?: 'planned' | 'reserved' | 'ready' | 'provider_rejected';
    trigger?: 'initial' | 'recovery' | 'user_regenerate';
  }) {
    const id = randomUUID();
    return {
      id,
      ownerUserId: args.ownerUserId,
      activitySessionId: args.activitySessionId,
      plan: RECOVERY_PLAN,
      planVersion: 'test-plan',
      promptVersion: 'test-prompt',
      planHash: `plan-${id}`,
      promptHash: `prompt-${id}`,
      fingerprint: {},
      providerKey: 'test-provider',
      model: 'test-model',
      capabilitySnapshot: {},
      idempotencyKey: `cover-${id}`,
      retryPolicy: {},
      selectedReferences: [],
      coverImageId: randomUUID(),
      storageKey: `covers/${id}.webp`,
      ...(args.initialState ? { initialState: args.initialState } : {}),
      ...(args.trigger ? { trigger: args.trigger } : {}),
    };
  }

  it('records a user-regeneration attempt alongside a settled attempt', async () => {
    const ownerUserId = await createUser(ctx.db);
    const activitySessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
    const first = await planSessionCoverGeneration(
      ctx.db,
      attemptInput({ ownerUserId, activitySessionId, initialState: 'ready' }),
    );
    expect(first).not.toBeNull();

    const second = await planSessionCoverGeneration(
      ctx.db,
      attemptInput({ ownerUserId, activitySessionId, trigger: 'user_regenerate' }),
    );
    expect(second).not.toBeNull();
    expect(second?.trigger).toBe('user_regenerate');
    expect(first?.trigger).toBe('initial');
  });

  it('never records two live attempts for the same session', async () => {
    const ownerUserId = await createUser(ctx.db);
    const activitySessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
    const live = await planSessionCoverGeneration(
      ctx.db,
      attemptInput({ ownerUserId, activitySessionId }),
    );
    expect(live).not.toBeNull();

    const duplicate = await planSessionCoverGeneration(
      ctx.db,
      attemptInput({ ownerUserId, activitySessionId, trigger: 'user_regenerate' }),
    );
    expect(duplicate).toBeNull();
  });

  it('resolves the live attempt and the latest attempt independently', async () => {
    const ownerUserId = await createUser(ctx.db);
    const activitySessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
    const settled = await planSessionCoverGeneration(
      ctx.db,
      attemptInput({ ownerUserId, activitySessionId, initialState: 'provider_rejected' }),
    );
    await ctx.db
      .update(sessionCoverGenerations)
      .set({ createdAt: new Date('2026-07-01T00:00:00.000Z') })
      .where(eq(sessionCoverGenerations.id, settled!.id));
    expect(
      await getLiveSessionCoverGeneration(ctx.db, { ownerUserId, activitySessionId }),
    ).toBeNull();

    const live = await planSessionCoverGeneration(
      ctx.db,
      attemptInput({ ownerUserId, activitySessionId, trigger: 'user_regenerate' }),
    );
    expect(
      (await getLiveSessionCoverGeneration(ctx.db, { ownerUserId, activitySessionId }))?.id,
    ).toBe(live!.id);
    expect((await getSessionCoverGeneration(ctx.db, { ownerUserId, activitySessionId }))?.id).toBe(
      live!.id,
    );
  });
});

describeIfDb('Session Cover generation history', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-session-cover-history-test');
  }, 60_000);

  afterAll(async () => ctx?.pool.end());

  beforeEach(async () => truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES));

  async function insertGeneration(args: {
    ownerUserId: string;
    state: 'ready' | 'planned' | 'submitting' | 'storing' | 'quality_rejected';
    createdAt: Date;
  }) {
    const activitySessionId = await createSession(ctx.db, {
      ownerUserId: args.ownerUserId,
      status: 'stopped',
      title: 'History fixture',
    });
    const id = randomUUID();
    await planSessionCoverGeneration(ctx.db, {
      id,
      ownerUserId: args.ownerUserId,
      activitySessionId,
      plan: HISTORY_PLAN,
      planVersion: 'test-plan',
      promptVersion: 'test-prompt',
      planHash: `plan-${id}`,
      promptHash: `prompt-${id}`,
      fingerprint: { preset: 'minimal', subject: id },
      providerKey: 'test',
      model: 'test',
      capabilitySnapshot: {},
      idempotencyKey: `cover-${id}`,
      retryPolicy: {},
      selectedReferences: [],
      coverImageId: randomUUID(),
      storageKey: `covers/${id}.webp`,
      initialState: args.state,
    });
    await ctx.db
      .update(sessionCoverGenerations)
      .set({ createdAt: args.createdAt })
      .where(eq(sessionCoverGenerations.id, id));
    return id;
  }

  it('returns only the owner latest 24 ready or live generation fingerprints', async () => {
    const ownerUserId = await createUser(ctx.db);
    const otherOwnerUserId = await createUser(ctx.db);
    const expectedNewestFirst: string[] = [];
    for (let index = 0; index < 27; index += 1) {
      const id = await insertGeneration({
        ownerUserId,
        state: index % 3 === 0 ? 'planned' : index % 3 === 1 ? 'submitting' : 'ready',
        createdAt: new Date(Date.UTC(2026, 6, 1, 0, index)),
      });
      expectedNewestFirst.unshift(id);
    }
    const storingId = await insertGeneration({
      ownerUserId,
      state: 'storing',
      createdAt: new Date('2026-07-02T00:00:00.000Z'),
    });
    await insertGeneration({
      ownerUserId,
      state: 'quality_rejected',
      createdAt: new Date('2026-07-03T00:00:00.000Z'),
    });
    await insertGeneration({
      ownerUserId: otherOwnerUserId,
      state: 'ready',
      createdAt: new Date('2026-07-04T00:00:00.000Z'),
    });

    const rows = await listRecentSessionCoverGenerations(ctx.db, { ownerUserId, limit: 200 });

    expect(rows.map((row) => row.id)).toEqual([storingId, ...expectedNewestFirst.slice(0, 23)]);
    expect(
      rows.every((row) => ['ready', 'planned', 'submitting', 'storing'].includes(row.state)),
    ).toBe(true);
  });
});

// The Cover images card warns while the Instance's newest Cover outcome is an
// account the image provider refused; a later Cover that landed clears it.
describeIfDb('Instance Cover account outcome', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-cover-account-outcome-test');
  }, 60_000);

  afterAll(async () => ctx?.pool.end());

  beforeEach(async () => truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES));

  async function settledAttempt(args: {
    ownerUserId: string;
    providerKey: string;
    state: 'ready' | 'provider_rejected' | 'provider_unavailable';
    failureCategory?: string;
    settledAt: Date;
  }) {
    const activitySessionId = await createSession(ctx.db, {
      ownerUserId: args.ownerUserId,
      status: 'stopped',
    });
    const id = randomUUID();
    await planSessionCoverGeneration(ctx.db, {
      id,
      ownerUserId: args.ownerUserId,
      activitySessionId,
      plan: RECOVERY_PLAN,
      planVersion: 'test-plan',
      promptVersion: 'test-prompt',
      planHash: `plan-${id}`,
      promptHash: `prompt-${id}`,
      fingerprint: {},
      providerKey: args.providerKey,
      model: 'test-model',
      capabilitySnapshot: {},
      idempotencyKey: `cover-${id}`,
      retryPolicy: {},
      selectedReferences: [],
      coverImageId: randomUUID(),
      storageKey: `covers/${id}.webp`,
    });
    await ctx.db
      .update(sessionCoverGenerations)
      .set({
        state: args.state,
        failureCategory: args.failureCategory ?? null,
        settledAt: args.settledAt,
      })
      .where(eq(sessionCoverGenerations.id, id));
  }

  it('reports nothing before any Cover has settled', async () => {
    expect(await getLatestCoverAccountOutcome(ctx.db)).toBeNull();
  });

  it('reports the newest refusal across owners, ignoring failures that say nothing about the account', async () => {
    const admin = await createUser(ctx.db);
    const member = await createUser(ctx.db);
    await settledAttempt({
      ownerUserId: admin,
      providerKey: 'gemini',
      state: 'ready',
      settledAt: new Date('2026-11-18T10:00:00.000Z'),
    });
    await settledAttempt({
      ownerUserId: member,
      providerKey: 'gemini',
      state: 'provider_rejected',
      failureCategory: 'account_not_ready',
      settledAt: new Date('2026-11-18T11:00:00.000Z'),
    });
    await settledAttempt({
      ownerUserId: admin,
      providerKey: 'gemini',
      state: 'provider_unavailable',
      failureCategory: 'provider_unavailable',
      settledAt: new Date('2026-11-18T12:00:00.000Z'),
    });

    expect(await getLatestCoverAccountOutcome(ctx.db)).toEqual({
      providerKey: 'gemini',
      accountNotReady: true,
      settledAt: new Date('2026-11-18T11:00:00.000Z'),
    });
  });

  it('reports a Cover that landed after the refusal', async () => {
    const ownerUserId = await createUser(ctx.db);
    await settledAttempt({
      ownerUserId,
      providerKey: 'openai',
      state: 'provider_rejected',
      failureCategory: 'account_not_ready',
      settledAt: new Date('2026-11-18T10:00:00.000Z'),
    });
    await settledAttempt({
      ownerUserId,
      providerKey: 'openai',
      state: 'ready',
      settledAt: new Date('2026-11-18T11:00:00.000Z'),
    });

    expect(await getLatestCoverAccountOutcome(ctx.db)).toMatchObject({ accountNotReady: false });
  });
});
