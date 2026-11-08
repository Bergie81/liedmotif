import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, ne } from 'drizzle-orm';
import {
  activitySessions,
  coverImages,
  reserveSessionCoverRegeneration,
  sessionCoverGenerations,
  updateUsageLimits,
} from '@liedmotif/db';
import {
  connectTestDb,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import {
  GeneratedImageProviderError,
  type GeneratedImageCapabilities,
  type GeneratedImageProvider,
  type GeneratedImageRequest,
} from '@liedmotif/providers';
import { createMockStorageProvider, storageKeys, type MockStorage } from '@liedmotif/storage';
import {
  createSessionCoverGenerator,
  SessionCoverRetryableError,
  type SessionCoverGenerator,
  type SessionCoverGeneratorDeps,
} from './session-cover-generator';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const FIXTURE_TABLES = [...GENERATION_FIXTURE_TABLES, 'cover_images', 'app_settings'] as const;

const SNAPSHOT = {
  stylePrompt: 'mellow lofi hip hop, vinyl crackle',
  mood: 'calm',
  activity: 'focus',
  energy: 'low',
  genreTags: ['lofi'],
};

const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);

function fakeCoverArt(behavior: { error?: Error } = {}) {
  const calls: GeneratedImageRequest[] = [];
  const capabilities: GeneratedImageCapabilities = {
    provider: { providerType: 'image', providerKey: 'fake-images', model: 'test/cover-model' },
    maxPromptCharacters: 8_000,
    exclusions: 'inline',
    nativeSeed: true,
    idempotency: 'absent',
    references: null,
    squareOutput: 'native',
    maxCandidates: 1,
    costReporting: true,
  };
  const provider: GeneratedImageProvider = {
    providerType: 'image',
    providerKey: 'fake-images',
    model: 'test/cover-model',
    async getCapabilities() {
      return capabilities;
    },
    async generate(input) {
      calls.push(input);
      if (behavior.error) throw behavior.error;
      return {
        provider: capabilities.provider,
        bytes: IMAGE_BYTES,
        mediaType: 'image/png',
        reportedCostUsd: 0.01,
        appliedControls: {
          exclusions: 'inline',
          square: 'native',
          references: input.references.length,
          seed: input.seed !== undefined,
          idempotency: capabilities.idempotency,
          candidateCount: 1,
        },
        downgradeCodes: ['exclusions_inlined', 'idempotency_unavailable'],
      };
    },
    async validateCredentials() {
      return { ok: true };
    },
  };
  return { provider, calls };
}

describeIfDb('SessionCoverGenerator regeneration', () => {
  let ctx: TestDb;
  let store: MockStorage;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-session-cover-regeneration-test');
    store = createMockStorageProvider();
  }, 60_000);

  afterAll(async () => {
    await ctx?.pool.end();
    await store?.cleanup();
  });

  beforeEach(async () => {
    await truncateTables(ctx.pool, FIXTURE_TABLES);
  });

  /** A session already wearing a landed generated cover (the one a failed
   *  regeneration must keep). */
  async function seedSessionWithCurrentCover() {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: SNAPSHOT,
      title: 'Instrumental Session',
    });
    const [current] = await ctx.db
      .insert(coverImages)
      .values({
        sourceType: 'generated',
        storageProvider: 'local-fs',
        storageKey: 'covers/generated/current.webp',
      })
      .returning({ id: coverImages.id });
    const currentCoverId = current!.id;
    await ctx.db
      .update(activitySessions)
      .set({ coverImageId: currentCoverId })
      .where(eq(activitySessions.id, sessionId));
    return { ownerUserId, sessionId, currentCoverId };
  }

  async function reserveAttempt(ownerUserId: string, sessionId: string, guidance?: string) {
    const attemptId = randomUUID();
    const coverImageId = randomUUID();
    const row = await reserveSessionCoverRegeneration(ctx.db, {
      id: attemptId,
      ownerUserId,
      activitySessionId: sessionId,
      coverImageId,
      storageKey: storageKeys.generatedCover(ownerUserId, sessionId, coverImageId, 'webp'),
      ...(guidance === undefined ? {} : { userGuidance: guidance }),
    });
    expect(row).not.toBeNull();
    return row!;
  }

  function generator(
    ownerUserId: string,
    imageProvider: GeneratedImageProvider | null,
    overrides: Partial<SessionCoverGeneratorDeps> = {},
  ): SessionCoverGenerator & { embedded: string[] } {
    const embedded: string[] = [];
    const instance = createSessionCoverGenerator({
      db: ctx.db,
      ownerUserId,
      imageProvider,
      storage: store.provider,
      evaluateCover: async () => ({ ok: true, width: 1024, height: 1024 }),
      normalizeCover: async (bytes) => bytes,
      measureCover: async () => ({ width: 1024, height: 1024 }),
      metadataQueue: {
        enqueue: async (trackId) => {
          embedded.push(trackId);
        },
      },
      logger: { info: () => undefined, warn: () => undefined },
      clock: { now: () => new Date('2026-07-20T12:00:00.000Z') },
      ...overrides,
    });
    return Object.assign(instance, { embedded });
  }

  async function sessionCoverId(sessionId: string): Promise<string | null> {
    const [row] = await ctx.db
      .select({ coverImageId: activitySessions.coverImageId })
      .from(activitySessions)
      .where(eq(activitySessions.id, sessionId));
    return row!.coverImageId;
  }

  async function ledgerRow(id: string) {
    const [row] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.id, id));
    return row ?? null;
  }

  async function initialRows(sessionId: string) {
    return ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(
        and(
          eq(sessionCoverGenerations.activitySessionId, sessionId),
          ne(sessionCoverGenerations.trigger, 'user_regenerate'),
        ),
      );
  }

  it('plans a reserved user regeneration and lands the cover in history awaiting confirmation', async () => {
    const { ownerUserId, sessionId, currentCoverId } = await seedSessionWithCurrentCover();
    const attempt = await reserveAttempt(ownerUserId, sessionId);

    const { provider, calls } = fakeCoverArt();
    const d = generator(ownerUserId, provider);
    const result = await d.processRegeneration(sessionId, attempt.id);

    expect(result).toMatchObject({ status: 'ready', generatedNow: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ purpose: 'session-cover', count: 1 });
    // Confirm-first: the session keeps its cover until the user selects the
    // new one — the attempt only joins the history.
    expect(await sessionCoverId(sessionId)).toBe(currentCoverId);
    const settled = await ledgerRow(attempt.id);
    expect(settled).toMatchObject({ state: 'ready', trigger: 'user_regenerate' });
    const [cover] = await ctx.db
      .select()
      .from(coverImages)
      .where(eq(coverImages.id, attempt.coverImageId));
    expect(cover?.sourceType).toBe('generated');
    expect(d.embedded).toHaveLength(0);
  });

  it('keeps the current cover and settles terminally when the regeneration fails', async () => {
    const { ownerUserId, sessionId, currentCoverId } = await seedSessionWithCurrentCover();
    const attempt = await reserveAttempt(ownerUserId, sessionId);

    const { provider } = fakeCoverArt({
      error: new GeneratedImageProviderError('rejection', 'not_started'),
    });
    const d = generator(ownerUserId, provider);
    const result = await d.processRegeneration(sessionId, attempt.id);

    expect(result).toMatchObject({ status: 'fallback', coverImageId: currentCoverId });
    expect(await sessionCoverId(sessionId)).toBe(currentCoverId);
    const settled = await ledgerRow(attempt.id);
    expect(settled?.state).toBe('provider_rejected');
    expect(settled?.settledAt).not.toBeNull();
  });

  it('refuses admission at the cover limit without spending or touching the cover', async () => {
    const { ownerUserId, sessionId, currentCoverId } = await seedSessionWithCurrentCover();
    await updateUsageLimits(ctx.db, { generatedCoversPerDay: 0 });
    const attempt = await reserveAttempt(ownerUserId, sessionId);

    const { provider, calls } = fakeCoverArt();
    const d = generator(ownerUserId, provider);
    const result = await d.processRegeneration(sessionId, attempt.id);

    expect(result).toMatchObject({ status: 'fallback', coverImageId: currentCoverId });
    expect(calls).toHaveLength(0);
    expect(await sessionCoverId(sessionId)).toBe(currentCoverId);
    const settled = await ledgerRow(attempt.id);
    expect(settled?.state).toBe('not_admitted');
    expect(settled?.possiblyPaid).toBe(false);
  });

  it('admits a regeneration whose own reservation is the last unit of budget', async () => {
    const { ownerUserId, sessionId } = await seedSessionWithCurrentCover();
    await updateUsageLimits(ctx.db, { generatedCoversPerDay: 1 });
    const attempt = await reserveAttempt(ownerUserId, sessionId);

    const { provider, calls } = fakeCoverArt();
    const d = generator(ownerUserId, provider);
    const result = await d.processRegeneration(sessionId, attempt.id);

    expect(result).toMatchObject({ status: 'ready', generatedNow: true });
    expect(calls).toHaveLength(1);
  });

  it('freezes the modal guidance into the composed provider prompt', async () => {
    const { ownerUserId, sessionId } = await seedSessionWithCurrentCover();
    const attempt = await reserveAttempt(
      ownerUserId,
      sessionId,
      'warm dusk light over a paper skyline',
    );

    const { provider, calls } = fakeCoverArt();
    const d = generator(ownerUserId, provider);
    const result = await d.processRegeneration(sessionId, attempt.id);

    expect(result).toMatchObject({ status: 'ready' });
    expect(calls[0]!.positivePrompt).toContain('"warm dusk light over a paper skyline"');
    const settled = await ledgerRow(attempt.id);
    expect(settled?.plan.userGuidance).toBe('warm dusk light over a paper skyline');
  });

  it('replays a settled attempt without ever touching the session cover', async () => {
    const { ownerUserId, sessionId, currentCoverId } = await seedSessionWithCurrentCover();
    const attempt = await reserveAttempt(ownerUserId, sessionId);
    const { provider } = fakeCoverArt();
    const d = generator(ownerUserId, provider);
    await d.processRegeneration(sessionId, attempt.id);

    const replay = await d.processRegeneration(sessionId, attempt.id);
    expect(replay).toMatchObject({ status: 'ready', generatedNow: false });
    expect(await sessionCoverId(sessionId)).toBe(currentCoverId);
  });

  it('leaves a reserved regeneration to its own job when the initial-cover job runs first', async () => {
    // The initial-cover job of a standard Session carries the music-task
    // provider; a regeneration it drove would ignore the guidance.
    const { ownerUserId, sessionId } = await seedSessionWithCurrentCover();
    await ctx.db
      .update(activitySessions)
      .set({ coverImageId: null })
      .where(eq(activitySessions.id, sessionId));
    const attempt = await reserveAttempt(ownerUserId, sessionId, 'neon city at dusk');
    const { provider, calls } = fakeCoverArt();

    const initial = await generator(ownerUserId, provider).ensureGenerated(sessionId);

    expect(initial).toEqual({ status: 'pending' });
    expect(calls).toHaveLength(0);
    expect((await ledgerRow(attempt.id))?.state).toBe('reserved');
  });

  it("retries a standard Session's owed initial cover while a regeneration holds the live slot", async () => {
    const { ownerUserId, sessionId } = await seedSessionWithCurrentCover();
    await ctx.db
      .update(activitySessions)
      .set({ coverImageId: null, useStandardCover: true })
      .where(eq(activitySessions.id, sessionId));
    const attempt = await reserveAttempt(ownerUserId, sessionId, 'neon city at dusk');
    const { provider, calls } = fakeCoverArt();

    await expect(
      generator(ownerUserId, provider).ensureGenerated(sessionId),
    ).rejects.toBeInstanceOf(SessionCoverRetryableError);
    expect(calls).toHaveLength(0);
    expect((await ledgerRow(attempt.id))?.state).toBe('reserved');
    expect(await initialRows(sessionId)).toHaveLength(0);
  });

  it("still admits a standard Session's initial cover after an early regeneration failed", async () => {
    const { ownerUserId, sessionId } = await seedSessionWithCurrentCover();
    await ctx.db
      .update(activitySessions)
      .set({ coverImageId: null, useStandardCover: true })
      .where(eq(activitySessions.id, sessionId));
    const attempt = await reserveAttempt(ownerUserId, sessionId, 'neon city at dusk');
    const failing = fakeCoverArt({
      error: new GeneratedImageProviderError('rejection', 'not_started'),
    });
    await generator(ownerUserId, failing.provider).processRegeneration(sessionId, attempt.id);
    expect((await ledgerRow(attempt.id))?.state).toBe('provider_rejected');

    const { provider, calls } = fakeCoverArt();
    const result = await generator(ownerUserId, provider).ensureGenerated(sessionId);

    expect(result).toMatchObject({ status: 'ready', generatedNow: true });
    expect(calls).toHaveLength(1);
    const [initial] = await initialRows(sessionId);
    expect(initial).toMatchObject({ trigger: 'initial', state: 'ready' });
    expect(await sessionCoverId(sessionId)).toBe(initial!.coverImageId);
    expect((await ledgerRow(attempt.id))?.state).toBe('provider_rejected');
  });

  it("admits a standard Session's initial cover into history behind a cover the user already picked", async () => {
    const { ownerUserId, sessionId, currentCoverId } = await seedSessionWithCurrentCover();
    await ctx.db
      .update(activitySessions)
      .set({ useStandardCover: true })
      .where(eq(activitySessions.id, sessionId));
    const attempt = await reserveAttempt(ownerUserId, sessionId);
    const { provider, calls } = fakeCoverArt();
    await generator(ownerUserId, provider).processRegeneration(sessionId, attempt.id);

    const result = await generator(ownerUserId, provider).ensureGenerated(sessionId);

    expect(result).toEqual({ status: 'preserved', coverImageId: currentCoverId });
    expect(calls).toHaveLength(2);
    const [initial] = await initialRows(sessionId);
    expect(initial).toMatchObject({ trigger: 'initial', state: 'ready' });
    expect(await sessionCoverId(sessionId)).toBe(currentCoverId);
    expect((await ledgerRow(attempt.id))?.state).toBe('ready');
  });
});
