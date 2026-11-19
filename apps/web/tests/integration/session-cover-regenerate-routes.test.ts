import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  connectTestDb,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { randomUUID } from 'node:crypto';
import {
  activitySessions,
  createPool,
  DEFAULT_USAGE_LIMITS,
  ensureOwnerPerson,
  insertGeneratedCoverImage,
  insertPersonReferencePhoto,
  lockAndResolveBudgetScopes,
  lockSessionForBuffer,
  planSessionCoverGeneration,
  sessionCoverGenerations,
  updateCoverArtSettings,
  updateSessionCoverGeneration,
  updateUsageLimits,
  userProfiles,
  withTransaction,
  type SessionCoverPlanRecord,
} from '@liedmotif/db';
import { COVER_STYLE_PRESETS, MAX_SESSION_COVER_HISTORY } from '@liedmotif/shared';

// Owner-scoped Session Cover regeneration routes: reserving exactly one
// live attempt, pending on double-tap, cross-owner rejection, and the sanitized
// status projection the modal polls.

const holder = vi.hoisted(() => ({
  db: null as unknown,
  ownerUserId: null as string | null,
  enqueued: [] as Array<{
    activitySessionId: string;
    ownerUserId: string;
    coverGenerationId: string;
  }>,
  retagged: [] as string[],
  llm: null as null | {
    enhanceCoverDirection: (input: {
      text: string;
      context: Record<string, unknown>;
    }) => Promise<{ text: string; applied: boolean }>;
  },
  enhanceCalls: [] as Array<{ text: string; context: Record<string, unknown> }>,
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
// The real music resolution stays: the Suno cover source reads it.
vi.mock('@/lib/providers/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/providers/providers')>()),
  getLlmProvider: async () => holder.llm,
  getStorageProvider: () => ({ providerKey: 'local-fs' }),
}));
vi.mock('@/lib/worker-jobs', () => ({
  enqueueRegenerateSessionCover: async (
    _db: unknown,
    args: { activitySessionId: string; ownerUserId: string; coverGenerationId: string },
  ) => {
    holder.enqueued.push(args);
    return true;
  },
  enqueueEmbedTrackMetadataBatch: async (_db: unknown, trackIds: string[]) => {
    holder.retagged.push(...trackIds);
  },
}));

const { POST: regeneratePost } = await import('@/app/api/sessions/cover/regenerate/route');
const { POST: statusPost } = await import('@/app/api/sessions/cover/status/route');
const { POST: selectPost } = await import('@/app/api/sessions/cover/select/route');
const { POST: deletePost } = await import('@/app/api/sessions/cover/delete/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

const READY_PLAN: SessionCoverPlanRecord = {
  sessionName: 'Route fixture',
  coverConcept: null,
  selectedStyle: 'minimal',
  resolvedStyle: 'minimal',
  customDefinition: null,
  styleFallbackReason: null,
  concreteScene: 'one controlled scene',
  semanticCueIds: ['name:exact'],
  conceptMode: 'title symbol',
  subjectFamily: 'symbol',
  composition: 'centered',
  palette: 'blue',
  material: 'paper',
  lighting: 'soft',
  referenceTreatment: null,
  prompt: 'private prompt',
  exclusions: [],
  altText: 'Route fixture cover',
  candidateCount: 1,
};

/** A settled, servable generated attempt (ledger row + cover_images row). */
async function seedReadyAttempt(
  ownerUserId: string,
  activitySessionId: string,
  opts: { createdAt?: Date } = {},
) {
  const id = randomUUID();
  const coverImageId = randomUUID();
  const storageKey = `covers/generated/${ownerUserId}/${activitySessionId}/${coverImageId}.webp`;
  await planSessionCoverGeneration(testDb.db, {
    id,
    ownerUserId,
    activitySessionId,
    plan: READY_PLAN,
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
    coverImageId,
    storageKey,
    initialState: 'ready',
    trigger: 'user_regenerate',
  });
  await insertGeneratedCoverImage(testDb.db, {
    id: coverImageId,
    ownerUserId,
    activitySessionId,
    storageProvider: 'local-fs',
    storageKey,
    byteSize: 1,
    label: 'Route fixture cover',
    model: 'test-model',
    activityFit: [],
    moodFit: [],
    genreFit: [],
    energyFit: [],
  });
  if (opts.createdAt) {
    await testDb.db
      .update(sessionCoverGenerations)
      .set({ createdAt: opts.createdAt })
      .where(eq(sessionCoverGenerations.id, id));
  }
  return { id, coverImageId };
}

function postJson(handler: (r: Request) => Promise<Response>, body: unknown) {
  return handler(
    new Request('http://localhost/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('session-cover-regenerate-routes-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  // `cover_images` must go too: the fixture owner ids repeat across processes,
  // so a previous run's generated covers would count as this owner's legacy
  // cover usage.
  await truncateTables(testDb.pool, [...GENERATION_FIXTURE_TABLES, 'app_settings', 'cover_images']);
  holder.ownerUserId = null;
  holder.enqueued = [];
  holder.retagged = [];
  holder.llm = null;
  holder.enhanceCalls = [];
  // A usable image provider unless a test opts out (the route's provider gate).
  vi.stubEnv('IMAGE_PROVIDER', 'openrouter');
  vi.stubEnv('IMAGE_API_KEY', 'test-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.skipIf(skip)('POST /api/sessions/cover/regenerate', () => {
  it('reserves one user-regeneration attempt and enqueues its per-attempt job', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;

    const response = await postJson(regeneratePost, { activitySessionId: sessionId });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { outcome: string; coverGenerationId: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.outcome).toBe('started');

    const rows = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: body.data.coverGenerationId,
      state: 'reserved',
      trigger: 'user_regenerate',
      possiblyPaid: false,
    });
    expect(holder.enqueued).toEqual([
      { activitySessionId: sessionId, ownerUserId, coverGenerationId: body.data.coverGenerationId },
    ]);
  });

  it('returns the live attempt as pending on a double-tap instead of spending again', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;

    const first = (await (
      await postJson(regeneratePost, { activitySessionId: sessionId })
    ).json()) as {
      data: { coverGenerationId: string };
    };
    const second = await postJson(regeneratePost, { activitySessionId: sessionId });
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      data: { outcome: string; coverGenerationId: string };
    };
    expect(body.data.outcome).toBe('pending');
    expect(body.data.coverGenerationId).toBe(first.data.coverGenerationId);

    const rows = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(rows).toHaveLength(1);
    expect(holder.enqueued).toHaveLength(1);
  });

  it('rejects a foreign session without creating an attempt', async () => {
    const ownerUserId = await createUser(testDb.db);
    const otherOwnerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId: otherOwnerUserId });
    holder.ownerUserId = ownerUserId;

    const response = await postJson(regeneratePost, { activitySessionId: sessionId });
    expect(response.status).toBe(404);
    const rows = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(rows).toHaveLength(0);
    expect(holder.enqueued).toHaveLength(0);
  });

  it('rejects unauthenticated requests', async () => {
    const response = await postJson(regeneratePost, {
      activitySessionId: '00000000-0000-4000-8000-000000000000',
    });
    expect(response.status).toBe(401);
  });

  it('persists a changed style on the session and freezes the guidance into the attempt', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId, coverStyle: 'auto' });
    holder.ownerUserId = ownerUserId;

    const response = await postJson(regeneratePost, {
      activitySessionId: sessionId,
      coverStyle: 'drawing',
      guidance: 'warm dusk light over a paper skyline',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { coverGenerationId: string } };

    const [session] = await testDb.db
      .select({
        coverStyle: activitySessions.coverStyle,
        coverStyleHint: activitySessions.coverStyleHint,
      })
      .from(activitySessions)
      .where(eq(activitySessions.id, sessionId));
    expect(session).toEqual({ coverStyle: 'drawing', coverStyleHint: null });

    const [attempt] = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.id, body.data.coverGenerationId));
    expect(attempt?.plan.userGuidance).toBe('warm dusk light over a paper skyline');
  });

  it('resolves Random to a concrete persisted style at request time', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId, coverStyle: 'auto' });
    holder.ownerUserId = ownerUserId;

    const response = await postJson(regeneratePost, {
      activitySessionId: sessionId,
      coverStyle: 'random',
    });
    expect(response.status).toBe(200);
    const [session] = await testDb.db
      .select({ coverStyle: activitySessions.coverStyle })
      .from(activitySessions)
      .where(eq(activitySessions.id, sessionId));
    expect(session!.coverStyle).not.toBe('auto');
    // No Custom definition is saved, so the roll is over the preset lanes alone.
    expect(COVER_STYLE_PRESETS).toContain(session!.coverStyle);
  });

  it('rejects over-long guidance', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;
    const response = await postJson(regeneratePost, {
      activitySessionId: sessionId,
      guidance: 'x'.repeat(501),
    });
    expect(response.status).toBe(400);
  });

  it('enhances the guidance at the web boundary and freezes raw plus effective text', async () => {
    holder.llm = {
      enhanceCoverDirection: async (input) => {
        holder.enhanceCalls.push(input);
        return { text: `ENHANCED ${input.text}`, applied: true };
      },
    };
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, {
      ownerUserId,
      title: 'Rain Session',
      styleSnapshot: { mood: 'calm', genreTags: ['ambient'] },
      coverStyle: 'minimal',
    });
    holder.ownerUserId = ownerUserId;

    const response = await postJson(regeneratePost, {
      activitySessionId: sessionId,
      guidance: 'warm dusk skyline',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { coverGenerationId: string } };
    const [attempt] = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.id, body.data.coverGenerationId));
    expect(attempt?.plan.userGuidance).toBe('warm dusk skyline');
    expect(attempt?.plan.effectiveGuidance).toBe('ENHANCED warm dusk skyline');
    expect(attempt?.plan.enhancementApplied).toBe(true);

    // The context carries only safe session facts — never Person About text.
    expect(holder.enhanceCalls).toHaveLength(1);
    expect(holder.enhanceCalls[0]!.context).toEqual({
      sessionName: 'Rain Session',
      style: 'minimal',
      mood: 'calm',
      genres: ['ambient'],
      imageModel: expect.any(String),
    });
  });

  it.each([true, false])(
    'freezes the Text AI reading of whether the wish includes the listener (%s)',
    async (includesListener) => {
      holder.llm = {
        enhanceCoverDirection: async (input) => ({
          text: `ENHANCED ${input.text}`,
          applied: true,
          includesListener,
        }),
      };
      const ownerUserId = await createUser(testDb.db);
      const sessionId = await createSession(testDb.db, { ownerUserId });
      holder.ownerUserId = ownerUserId;

      const body = (await (
        await postJson(regeneratePost, {
          activitySessionId: sessionId,
          guidance: 'Ich tanze mit Jonas',
        })
      ).json()) as { data: { coverGenerationId: string } };

      const [attempt] = await testDb.db
        .select()
        .from(sessionCoverGenerations)
        .where(eq(sessionCoverGenerations.id, body.data.coverGenerationId));
      expect(attempt?.plan.wishIncludesListener).toBe(includesListener);
    },
  );

  it('freezes no listener reading when the Text AI gives none', async () => {
    holder.llm = {
      enhanceCoverDirection: async (input) => ({ text: input.text, applied: false }),
    };
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;

    const body = (await (
      await postJson(regeneratePost, { activitySessionId: sessionId, guidance: 'me at the beach' })
    ).json()) as { data: { coverGenerationId: string } };

    const [attempt] = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.id, body.data.coverGenerationId));
    expect(attempt?.plan.wishIncludesListener).toBeUndefined();
  });

  it('gives the wish rewrite the preset an Auto cover plans in', async () => {
    holder.llm = {
      enhanceCoverDirection: async (input) => {
        holder.enhanceCalls.push(input);
        return { text: input.text, applied: true };
      },
    };
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, {
      ownerUserId,
      title: 'Rain Session',
      coverStyle: 'auto',
    });
    await testDb.pool.query(
      `update activity_sessions set auto_cover_style = 'manga' where id = $1`,
      [sessionId],
    );
    holder.ownerUserId = ownerUserId;

    const response = await postJson(regeneratePost, {
      activitySessionId: sessionId,
      guidance: 'warm dusk skyline',
    });
    expect(response.status).toBe(200);
    expect(holder.enhanceCalls[0]!.context).toMatchObject({ style: 'manga' });
  });

  it('falls back to the raw guidance when enhancement does not apply', async () => {
    holder.llm = {
      enhanceCoverDirection: async (input) => ({ text: input.text, applied: false }),
    };
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;

    const response = await postJson(regeneratePost, {
      activitySessionId: sessionId,
      guidance: 'warm dusk skyline',
    });
    const body = (await response.json()) as { data: { coverGenerationId: string } };
    const [attempt] = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.id, body.data.coverGenerationId));
    expect(attempt?.plan.userGuidance).toBe('warm dusk skyline');
    expect(attempt?.plan.effectiveGuidance).toBeUndefined();
    expect(attempt?.plan.enhancementApplied).toBe(false);
  });

  it.each([
    ['on', { usePeopleReferences: true }, true],
    ['off', { usePeopleReferences: false }, false],
    ['omitted', {}, undefined],
  ])(
    'freezes the People switch onto the reserved attempt when %s',
    async (_case, extra, frozen) => {
      const ownerUserId = await createUser(testDb.db);
      const sessionId = await createSession(testDb.db, { ownerUserId });
      holder.ownerUserId = ownerUserId;

      const body = (await (
        await postJson(regeneratePost, { activitySessionId: sessionId, ...extra })
      ).json()) as { data: { coverGenerationId: string } };

      const [attempt] = await testDb.db
        .select()
        .from(sessionCoverGenerations)
        .where(eq(sessionCoverGenerations.id, body.data.coverGenerationId));
      expect(attempt?.plan.usePeopleReferences).toBe(frozen);
    },
  );

  it('skips enhancement when the Enhance prompts setting is off', async () => {
    holder.llm = {
      enhanceCoverDirection: async (input) => {
        holder.enhanceCalls.push(input);
        return { text: `ENHANCED ${input.text}`, applied: true };
      },
    };
    const ownerUserId = await createUser(testDb.db);
    await updateCoverArtSettings(testDb.db, ownerUserId, { promptEnhancementEnabled: false });
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;

    // Setting off → deterministic even though an LLM is configured.
    const offBody = (await (
      await postJson(regeneratePost, { activitySessionId: sessionId, guidance: 'dusk skyline' })
    ).json()) as { data: { coverGenerationId: string } };
    const [offAttempt] = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.id, offBody.data.coverGenerationId));
    expect(holder.enhanceCalls).toHaveLength(0);
    expect(offAttempt?.plan.effectiveGuidance).toBeUndefined();
    expect(offAttempt?.plan.enhancementApplied).toBe(false);
  });

  it('runs the deterministic path byte-for-byte when no LLM is configured', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;

    const response = await postJson(regeneratePost, {
      activitySessionId: sessionId,
      guidance: 'warm dusk skyline',
    });
    const body = (await response.json()) as { data: { coverGenerationId: string } };
    const [attempt] = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.id, body.data.coverGenerationId));
    expect(attempt?.plan.userGuidance).toBe('warm dusk skyline');
    expect(attempt?.plan).not.toHaveProperty('effectiveGuidance');
    expect(attempt?.plan).not.toHaveProperty('enhancementApplied');
  });

  it('refuses at the cover limit without reserving or spending', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;
    await updateUsageLimits(testDb.db, { generatedCoversPerDay: 0 });

    const response = await postJson(regeneratePost, { activitySessionId: sessionId });
    expect(response.status).toBe(429);
    const rows = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(rows).toHaveLength(0);
    expect(holder.enqueued).toHaveLength(0);
  });

  it('refuses a guided regeneration over budget without burning the paid LLM call', async () => {
    // Enhancement runs before the in-lock admission, so a
    // budget-exhausted tap would spend one unmetered LLM call per tap. The
    // lock-free precheck must refuse first, before enhanceCoverText.
    holder.llm = {
      enhanceCoverDirection: async (input) => {
        holder.enhanceCalls.push(input);
        return { text: `ENHANCED ${input.text}`, applied: true };
      },
    };
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;
    await updateUsageLimits(testDb.db, { generatedCoversPerDay: 0 });

    const response = await postJson(regeneratePost, {
      activitySessionId: sessionId,
      guidance: 'warm dusk skyline',
    });
    expect(response.status).toBe(429);
    expect(holder.enhanceCalls).toHaveLength(0);
    const rows = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(rows).toHaveLength(0);
    expect(holder.enqueued).toHaveLength(0);
  });

  it('refuses a new attempt while the session holds the maximum of 10 covers', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;
    await updateUsageLimits(testDb.db, { generatedCoversPerDay: 50, generatedCoversPerMonth: 200 });
    for (let i = 0; i < MAX_SESSION_COVER_HISTORY; i += 1) {
      await seedReadyAttempt(ownerUserId, sessionId);
    }

    const response = await postJson(regeneratePost, { activitySessionId: sessionId });
    expect(response.status).toBe(429);
    const body = (await response.json()) as { ok: boolean; error: { message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.message).toMatch(/delete/i);
    const rows = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(rows).toHaveLength(MAX_SESSION_COVER_HISTORY);
    expect(holder.enqueued).toHaveLength(0);

    // Deleting one cover frees the slot again.
    const [session] = await testDb.db
      .select({ coverImageId: activitySessions.coverImageId })
      .from(activitySessions)
      .where(eq(activitySessions.id, sessionId));
    const statusBody = (await (
      await postJson(statusPost, { activitySessionId: sessionId })
    ).json()) as { data: { history: Array<{ coverImageId: string; isCurrent: boolean }> } };
    const deletable = statusBody.data.history.find((entry) => !entry.isCurrent)!;
    expect(session?.coverImageId ?? null).not.toBe(deletable.coverImageId);
    await postJson(deletePost, {
      activitySessionId: sessionId,
      coverImageId: deletable.coverImageId,
    });
    const retry = await postJson(regeneratePost, { activitySessionId: sessionId });
    expect(retry.status).toBe(200);
  });

  it('refuses when tailored cover art is disabled, never pointing a Member at admin settings', async () => {
    const ownerUserId = await createUser(testDb.db);
    await testDb.db.insert(userProfiles).values({ userId: ownerUserId, role: 'member' });
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;
    await updateUsageLimits(testDb.db, { tailoredCoverArtEnabled: false });

    const response = await postJson(regeneratePost, { activitySessionId: sessionId });
    expect(response.status).toBe(409);
    const { error } = (await response.clone().json()) as { error: { message: string } };
    expect(error.message).toContain('Admin');
    expect(error.message).not.toContain('Settings');
    expect(holder.enqueued).toHaveLength(0);
  });

  it('reserves nothing when the Session delete lands while the guidance is enhanced', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId, status: 'stopped' });
    holder.ownerUserId = ownerUserId;
    holder.llm = {
      enhanceCoverDirection: async ({ text }) => {
        await testDb.db
          .update(activitySessions)
          .set({ deleteRequestedAt: new Date(), pinnedAt: null })
          .where(eq(activitySessions.id, sessionId));
        return { text: `${text} enhanced`, applied: true };
      },
    };

    const response = await postJson(regeneratePost, {
      activitySessionId: sessionId,
      guidance: 'a lighthouse',
    });

    expect(response.status).toBe(404);
    const rows = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(rows).toHaveLength(0);
    expect(holder.enqueued).toHaveLength(0);
  });

  // A buffer tick locks the Session row and then the Members Pool; a Member's
  // style change must take the row before the Pool too, or the two deadlock.
  it('serializes a Member style change behind a buffer tick holding the Session row', async () => {
    const ownerUserId = await createUser(testDb.db);
    await testDb.db.insert(userProfiles).values({ userId: ownerUserId, role: 'member' });
    const sessionId = await createSession(testDb.db, { ownerUserId, coverStyle: 'auto' });
    holder.ownerUserId = ownerUserId;
    let releaseTick!: () => void;
    const tickMayTakePool = new Promise<void>((resolve) => {
      releaseTick = resolve;
    });
    let rowLocked!: () => void;
    const tickHoldsRow = new Promise<void>((resolve) => {
      rowLocked = resolve;
    });
    const tick = withTransaction(testDb.db, async (tx) => {
      await lockSessionForBuffer(tx, sessionId);
      rowLocked();
      await tickMayTakePool;
      await lockAndResolveBudgetScopes(tx, {
        ownerUserId,
        instanceLimits: DEFAULT_USAGE_LIMITS,
      });
    });
    await tickHoldsRow;

    const route = postJson(regeneratePost, { activitySessionId: sessionId, coverStyle: 'drawing' });
    // Both test-pool connections are busy (the tick and the route), so the lock
    // wait is observed from a connection of its own.
    const observer = createPool(TEST_DATABASE_URL!, { max: 1 });
    try {
      await vi.waitFor(async () => {
        const waiting = await observer.query<{ count: number }>(
          'select count(*)::int as count from pg_locks where not granted',
        );
        expect(waiting.rows[0]!.count).toBeGreaterThan(0);
      });
    } finally {
      releaseTick();
      await observer.end();
    }

    await expect(tick).resolves.toBeUndefined();
    const response = await route;
    expect(response.status).toBe(200);
    const [session] = await testDb.db
      .select({ coverStyle: activitySessions.coverStyle })
      .from(activitySessions)
      .where(eq(activitySessions.id, sessionId));
    expect(session?.coverStyle).toBe('drawing');
  });

  it('refuses when no image provider is configured', async () => {
    vi.stubEnv('IMAGE_PROVIDER', '');
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;

    const response = await postJson(regeneratePost, { activitySessionId: sessionId });
    expect(response.status).toBe(409);
    expect(holder.enqueued).toHaveLength(0);
  });
});

describe.skipIf(skip)('POST /api/sessions/cover/status', () => {
  it('reports a live regeneration as generating', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;
    const started = (await (
      await postJson(regeneratePost, { activitySessionId: sessionId })
    ).json()) as { data: { coverGenerationId: string } };

    const response = await postJson(statusPost, { activitySessionId: sessionId });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        coverImageId: string | null;
        generating: boolean;
        latestRegeneration: { coverGenerationId: string; status: string } | null;
      };
    };
    expect(body.data.generating).toBe(true);
    expect(body.data.latestRegeneration).toMatchObject({
      coverGenerationId: started.data.coverGenerationId,
      status: 'generating',
      failureMessageSafe: null,
    });
  });

  it('reports a settled failure with sanitized plain-language copy', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;
    const started = (await (
      await postJson(regeneratePost, { activitySessionId: sessionId })
    ).json()) as { data: { coverGenerationId: string } };
    await updateSessionCoverGeneration(testDb.db, {
      ownerUserId,
      id: started.data.coverGenerationId,
      state: 'provider_unavailable',
      failureCategory: 'provider_unavailable',
      settledAt: new Date(),
    });

    const body = (await (await postJson(statusPost, { activitySessionId: sessionId })).json()) as {
      data: {
        generating: boolean;
        latestRegeneration: { status: string; failureMessageSafe: string };
      };
    };
    expect(body.data.generating).toBe(false);
    expect(body.data.latestRegeneration.status).toBe('failed');
    expect(body.data.latestRegeneration.failureMessageSafe).toMatch(/unavailable/i);
  });

  it('rejects a foreign session', async () => {
    const ownerUserId = await createUser(testDb.db);
    const otherOwnerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId: otherOwnerUserId });
    holder.ownerUserId = ownerUserId;
    const response = await postJson(statusPost, { activitySessionId: sessionId });
    expect(response.status).toBe(404);
  });

  it('reports the day/month usage counters the worker admission counts', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;
    await updateUsageLimits(testDb.db, { generatedCoversPerDay: 5, generatedCoversPerMonth: 30 });

    const before = (await (
      await postJson(statusPost, { activitySessionId: sessionId })
    ).json()) as {
      data: { usage: Record<string, unknown> };
    };
    expect(before.data.usage).toMatchObject({
      usedDay: 0,
      limitDay: 5,
      usedMonth: 0,
      limitMonth: 30,
      remaining: 5,
      enabled: true,
      providerConfigured: true,
    });

    // A live reservation counts as possibly-paid usage immediately.
    await postJson(regeneratePost, { activitySessionId: sessionId });
    const after = (await (await postJson(statusPost, { activitySessionId: sessionId })).json()) as {
      data: { usage: Record<string, unknown> };
    };
    expect(after.data.usage).toMatchObject({ usedDay: 1, remaining: 4 });
  });

  it('lists the settled generated covers newest first with the current one marked', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;
    const older = await seedReadyAttempt(ownerUserId, sessionId, {
      createdAt: new Date('2026-07-18T10:00:00Z'),
    });
    const newer = await seedReadyAttempt(ownerUserId, sessionId, {
      createdAt: new Date('2026-07-19T10:00:00Z'),
    });
    await testDb.db
      .update(activitySessions)
      .set({ coverImageId: newer.coverImageId })
      .where(eq(activitySessions.id, sessionId));

    const body = (await (await postJson(statusPost, { activitySessionId: sessionId })).json()) as {
      data: { history: Array<{ coverImageId: string; isCurrent: boolean; style: string }> };
    };
    expect(body.data.history.map((entry) => entry.coverImageId)).toEqual([
      newer.coverImageId,
      older.coverImageId,
    ]);
    expect(body.data.history[0]).toMatchObject({ isCurrent: true, style: 'minimal' });
    expect(body.data.history[1]!.isCurrent).toBe(false);
  });

  it('offers People photos only once a Person has a reference photo and the frequency allows it', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;
    const available = async () =>
      (
        (await (await postJson(statusPost, { activitySessionId: sessionId })).json()) as {
          data: { peopleReferencesAvailable: boolean };
        }
      ).data.peopleReferencesAvailable;

    expect(await available()).toBe(false);

    const person = await ensureOwnerPerson(testDb.db, ownerUserId);
    const photoId = randomUUID();
    await insertPersonReferencePhoto(testDb.db, {
      id: photoId,
      ownerUserId,
      personId: person.id,
      storageProvider: 'local-fs',
      storageKey: `people/${ownerUserId}/${person.id}/${photoId}.webp`,
      mediaType: 'image/webp',
      byteSize: 4,
    });
    expect(await available()).toBe(true);
  });

  it('reflects disabled tailored cover art and a missing provider in the usage block', async () => {
    vi.stubEnv('IMAGE_PROVIDER', '');
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;
    await updateUsageLimits(testDb.db, { tailoredCoverArtEnabled: false });

    const body = (await (await postJson(statusPost, { activitySessionId: sessionId })).json()) as {
      data: { usage: { enabled: boolean; providerConfigured: boolean } };
    };
    expect(body.data.usage.enabled).toBe(false);
    expect(body.data.usage.providerConfigured).toBe(false);
  });

  it('reports the Suno source as active whenever tailored cover art cannot run', async () => {
    vi.stubEnv('MUSIC_PROVIDER', 'suno');
    vi.stubEnv('SUNO_API_KEY', 'test-music-key');
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;
    // The image provider stays configured: the switch alone hands the session over.
    await updateUsageLimits(testDb.db, { tailoredCoverArtEnabled: false });

    const read = async () =>
      (
        (await (await postJson(statusPost, { activitySessionId: sessionId })).json()) as {
          data: { usage: { sunoFallbackActive: boolean } };
        }
      ).data.usage.sunoFallbackActive;
    expect(await read()).toBe(true);

    await updateUsageLimits(testDb.db, { tailoredCoverArtEnabled: true });
    expect(await read()).toBe(false);

    // Nothing left to take over: covers stay on the placeholder, not Suno.
    await updateUsageLimits(testDb.db, { tailoredCoverArtEnabled: false });
    vi.stubEnv('MUSIC_PROVIDER', '');
    expect(await read()).toBe(false);
  });
});

describe.skipIf(skip)('POST /api/sessions/cover/select', () => {
  it('re-points the session to a previous generated cover for free and retags', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;
    const older = await seedReadyAttempt(ownerUserId, sessionId, {
      createdAt: new Date('2026-07-18T10:00:00Z'),
    });
    const newer = await seedReadyAttempt(ownerUserId, sessionId, {
      createdAt: new Date('2026-07-19T10:00:00Z'),
    });
    await testDb.db
      .update(activitySessions)
      .set({ coverImageId: newer.coverImageId })
      .where(eq(activitySessions.id, sessionId));

    const response = await postJson(selectPost, {
      activitySessionId: sessionId,
      coverImageId: older.coverImageId,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { coverImageId: string } };
    expect(body.data.coverImageId).toBe(older.coverImageId);

    const [session] = await testDb.db
      .select({ coverImageId: activitySessions.coverImageId })
      .from(activitySessions)
      .where(eq(activitySessions.id, sessionId));
    expect(session!.coverImageId).toBe(older.coverImageId);
    // Zero cost: no new ledger rows, no jobs — only the metadata retag.
    expect(holder.enqueued).toHaveLength(0);
  });

  it('rejects covers outside this session generation history', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    const otherSessionId = await createSession(testDb.db, { ownerUserId, status: 'stopped' });
    holder.ownerUserId = ownerUserId;
    const foreign = await seedReadyAttempt(ownerUserId, otherSessionId);

    const response = await postJson(selectPost, {
      activitySessionId: sessionId,
      coverImageId: foreign.coverImageId,
    });
    expect(response.status).toBe(404);
    const [session] = await testDb.db
      .select({ coverImageId: activitySessions.coverImageId })
      .from(activitySessions)
      .where(eq(activitySessions.id, sessionId));
    expect(session!.coverImageId).toBeNull();
  });

  it('rejects a foreign owner session', async () => {
    const ownerUserId = await createUser(testDb.db);
    const otherOwnerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId: otherOwnerUserId });
    holder.ownerUserId = ownerUserId;
    const attempt = await seedReadyAttempt(otherOwnerUserId, sessionId);

    const response = await postJson(selectPost, {
      activitySessionId: sessionId,
      coverImageId: attempt.coverImageId,
    });
    expect(response.status).toBe(404);
  });
});

describe.skipIf(skip)('POST /api/sessions/cover/delete', () => {
  it('deletes a non-current history cover and queues its bytes for reclamation', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;
    const older = await seedReadyAttempt(ownerUserId, sessionId, {
      createdAt: new Date('2026-07-18T10:00:00Z'),
    });
    const newer = await seedReadyAttempt(ownerUserId, sessionId, {
      createdAt: new Date('2026-07-19T10:00:00Z'),
    });
    await testDb.db
      .update(activitySessions)
      .set({ coverImageId: newer.coverImageId })
      .where(eq(activitySessions.id, sessionId));

    const response = await postJson(deletePost, {
      activitySessionId: sessionId,
      coverImageId: older.coverImageId,
    });
    expect(response.status).toBe(200);

    const statusBody = (await (
      await postJson(statusPost, { activitySessionId: sessionId })
    ).json()) as { data: { history: Array<{ coverImageId: string }> } };
    expect(statusBody.data.history.map((entry) => entry.coverImageId)).toEqual([
      newer.coverImageId,
    ]);
    const queued = await testDb.pool.query(
      'select reason from deletion_queue_items where owner_user_id = $1',
      [ownerUserId],
    );
    // The original and its cached tile rendition.
    expect(queued.rows).toEqual([
      { reason: 'session_cover_history_deleted' },
      { reason: 'session_cover_history_deleted' },
    ]);
    // Spend accounting survives: the ledger row is untouched.
    const [ledger] = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.id, older.id));
    expect(ledger?.state).toBe('ready');
  });

  it('refuses to delete the current cover', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;
    const current = await seedReadyAttempt(ownerUserId, sessionId);
    await testDb.db
      .update(activitySessions)
      .set({ coverImageId: current.coverImageId })
      .where(eq(activitySessions.id, sessionId));

    const response = await postJson(deletePost, {
      activitySessionId: sessionId,
      coverImageId: current.coverImageId,
    });
    expect(response.status).toBe(409);
  });

  it('rejects covers outside this session history and foreign owners', async () => {
    const ownerUserId = await createUser(testDb.db);
    const otherOwnerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    const foreignSessionId = await createSession(testDb.db, { ownerUserId: otherOwnerUserId });
    const foreign = await seedReadyAttempt(otherOwnerUserId, foreignSessionId);
    holder.ownerUserId = ownerUserId;

    const crossHistory = await postJson(deletePost, {
      activitySessionId: sessionId,
      coverImageId: foreign.coverImageId,
    });
    expect(crossHistory.status).toBe(404);
    const crossOwner = await postJson(deletePost, {
      activitySessionId: foreignSessionId,
      coverImageId: foreign.coverImageId,
    });
    expect(crossOwner.status).toBe(404);
  });
});
