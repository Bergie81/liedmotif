import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, ne } from 'drizzle-orm';
import {
  activitySessions,
  coverImages,
  createPerson,
  ensureOwnerPerson,
  insertPersonReferencePhoto,
  listenerProfiles,
  reserveSessionCoverRegeneration,
  sessionCoverGenerations,
  updatePerson,
  updateUsageLimits,
  type CoverReferenceFrequency,
  type CoverRequestProvenance,
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

const FIXTURE_TABLES = [
  ...GENERATION_FIXTURE_TABLES,
  'cover_images',
  'app_settings',
  'listener_profiles',
  'person_reference_photos',
  'people',
] as const;

const SNAPSHOT = {
  stylePrompt: 'mellow lofi hip hop, vinyl crackle',
  mood: 'calm',
  activity: 'focus',
  energy: 'low',
  genreTags: ['lofi'],
};

const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);

function fakeCoverArt(
  behavior: {
    error?: Error | ((attempt: number) => Error | undefined);
    idempotency?: GeneratedImageCapabilities['idempotency'];
    acceptsReferences?: boolean;
  } = {},
) {
  const calls: GeneratedImageRequest[] = [];
  const capabilities: GeneratedImageCapabilities = {
    provider: { providerType: 'image', providerKey: 'fake-images', model: 'test/cover-model' },
    maxPromptCharacters: 8_000,
    exclusions: 'inline',
    nativeSeed: true,
    idempotency: behavior.idempotency ?? 'absent',
    references: behavior.acceptsReferences
      ? {
          roles: ['subject'],
          maxCount: 3,
          multiSubjectIdentity: false,
          mediaTypes: ['image/jpeg', 'image/png', 'image/webp'],
          maxBytesPerReference: 2_000_000,
          maxTotalBytes: 4_000_000,
        }
      : null,
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
      const error =
        typeof behavior.error === 'function' ? behavior.error(calls.length) : behavior.error;
      if (error) throw error;
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

  async function reserveAttempt(
    ownerUserId: string,
    sessionId: string,
    guidance?: string,
    rewrittenGuidance?: string,
    wishIncludesListener?: boolean,
  ) {
    const attemptId = randomUUID();
    const coverImageId = randomUUID();
    const row = await reserveSessionCoverRegeneration(ctx.db, {
      id: attemptId,
      ownerUserId,
      activitySessionId: sessionId,
      coverImageId,
      storageKey: storageKeys.generatedCover(ownerUserId, sessionId, coverImageId, 'webp'),
      request: {
        userGuidance: guidance,
        wishIncludesListener,
        ...(rewrittenGuidance === undefined
          ? {}
          : { effectiveGuidance: rewrittenGuidance, enhancementApplied: true }),
      },
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
      textLlmConfigured: false,
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

  it('records an account that is not ready for images as its own cause, never as spend or a retry', async () => {
    const { ownerUserId, sessionId, currentCoverId } = await seedSessionWithCurrentCover();
    const attempt = await reserveAttempt(ownerUserId, sessionId);

    const { provider, calls } = fakeCoverArt({
      error: new GeneratedImageProviderError('account_not_ready', 'not_started'),
    });
    const result = await generator(ownerUserId, provider).processRegeneration(
      sessionId,
      attempt.id,
    );

    expect(result).toMatchObject({ status: 'fallback', coverImageId: currentCoverId });
    expect(calls).toHaveLength(1);
    expect(await ledgerRow(attempt.id)).toMatchObject({
      state: 'provider_rejected',
      failureCategory: 'account_not_ready',
      possiblyPaid: false,
    });
  });

  it('settles a reserved regeneration without spending once the Session delete is pending', async () => {
    const { ownerUserId, sessionId } = await seedSessionWithCurrentCover();
    const attempt = await reserveAttempt(ownerUserId, sessionId);
    await ctx.db
      .update(activitySessions)
      .set({ status: 'stopped', deleteRequestedAt: new Date() })
      .where(eq(activitySessions.id, sessionId));

    const { provider, calls } = fakeCoverArt();
    const result = await generator(ownerUserId, provider).processRegeneration(
      sessionId,
      attempt.id,
    );

    expect(result).toMatchObject({ status: 'fallback', reason: 'not_admitted' });
    expect(calls).toHaveLength(0);
    expect(await ledgerRow(attempt.id)).toMatchObject({
      state: 'not_admitted',
      possiblyPaid: false,
    });
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

  describe('People named in the cover wish', () => {
    interface SeededPerson {
      personId: string;
      photoIds: string[];
    }

    async function seedPhoto(ownerUserId: string, personId: string): Promise<string> {
      const photoId = randomUUID();
      const storageKey = storageKeys.personReferencePhoto(ownerUserId, personId, photoId, 'webp');
      await store.provider.write({
        key: storageKey,
        body: new Uint8Array([1, 2, 3, 4]),
        mimeType: 'image/webp',
      });
      const result = await insertPersonReferencePhoto(ctx.db, {
        id: photoId,
        ownerUserId,
        personId,
        storageProvider: 'local-fs',
        storageKey,
        mediaType: 'image/webp',
        byteSize: 4,
      });
      expect(result.inserted).toBe(true);
      return photoId;
    }

    /**
     * A Session with a current cover and configured People: the owner Person
     * is "Thomas", the others follow in configured order. `photos` says how
     * many reference photos each Person has.
     */
    async function seedPeopleSession(args: {
      userPrompt: string;
      photos: Record<string, number>;
      frequency?: CoverReferenceFrequency;
      includesListener?: boolean;
      skipProfile?: boolean;
    }) {
      const seeded = await seedSessionWithCurrentCover();
      const { ownerUserId, sessionId } = seeded;
      await ctx.db
        .insert(listenerProfiles)
        .values({ ownerUserId, coverReferenceFrequency: args.frequency ?? 'always' });
      const owner = await ensureOwnerPerson(ctx.db, ownerUserId);
      await updatePerson(ctx.db, {
        ownerUserId,
        personId: owner.id,
        name: 'Thomas',
        about: owner.about,
      });
      const people: Record<string, SeededPerson> = {};
      for (const [name, count] of Object.entries(args.photos)) {
        const personId =
          name === 'Thomas'
            ? owner.id
            : (await createPerson(ctx.db, { ownerUserId, name, about: '' })).id;
        const photoIds: string[] = [];
        for (let index = 0; index < count; index += 1) {
          photoIds.push(await seedPhoto(ownerUserId, personId));
        }
        people[name] = { personId, photoIds };
      }
      await ctx.db
        .update(activitySessions)
        .set({
          userPrompt: args.userPrompt,
          includesListener: args.includesListener ?? false,
          skipProfile: args.skipProfile ?? false,
        })
        .where(eq(activitySessions.id, sessionId));
      return { ...seeded, people };
    }

    async function referencesFor(
      seeded: { ownerUserId: string; sessionId: string },
      typedWish: string,
      rewrittenWish?: string,
      wishIncludesListener?: boolean,
    ) {
      const attempt = await reserveAttempt(
        seeded.ownerUserId,
        seeded.sessionId,
        typedWish,
        rewrittenWish,
        wishIncludesListener,
      );
      const { provider, calls } = fakeCoverArt({ acceptsReferences: true });
      const result = await generator(seeded.ownerUserId, provider).processRegeneration(
        seeded.sessionId,
        attempt.id,
      );
      expect(result).toMatchObject({ status: 'ready', generatedNow: true });
      expect(calls).toHaveLength(1);
      const sent = calls[0]!.references.map((reference) => reference.id);
      const frozen = (await ledgerRow(attempt.id))!.selectedReferences.map(
        (reference) => reference.id,
      );
      expect(frozen).toEqual(sent);
      return { sent, calls, attempt };
    }

    it('a Person named in the cover wish brings their photos', async () => {
      const seeded = await seedPeopleSession({
        userPrompt: 'A slow drive along the coast',
        photos: { Thomas: 1, Anna: 2 },
      });

      const { sent } = await referencesFor(seeded, 'Anna at the beach');

      expect(sent).toEqual(seeded.people.Anna!.photoIds);
    });

    async function frozenPersonIds(attemptId: string) {
      return (await ledgerRow(attemptId))!.selectedReferences.map(
        (reference) => reference.personId,
      );
    }

    it('only the People named in the wish decide the photos', async () => {
      const seeded = await seedPeopleSession({
        userPrompt: 'Roadtrip with Jonas',
        photos: { Thomas: 1, Jonas: 1, Anna: 3 },
      });

      const { sent } = await referencesFor(seeded, 'Anna at the beach');

      expect(sent).toEqual(seeded.people.Anna!.photoIds);
    });

    it("a wish that names nobody keeps the Session's own selection", async () => {
      const named = await seedPeopleSession({
        userPrompt: 'Roadtrip with Jonas',
        photos: { Thomas: 1, Jonas: 1, Anna: 1 },
        includesListener: true,
      });
      const withNames = await referencesFor(named, 'darker, more neon');
      expect(await frozenPersonIds(withNames.attempt.id)).toEqual([
        named.people.Thomas!.personId,
        named.people.Jonas!.personId,
      ]);

      const unnamed = await seedPeopleSession({
        userPrompt: 'A slow drive along the coast',
        photos: { Thomas: 1, Anna: 1 },
      });
      const fallback = await referencesFor(unnamed, 'darker, more neon');
      expect(fallback.sent).toEqual(unnamed.people.Thomas!.photoIds);
    });

    it('several People named in the wish each supply one photo, in configured order', async () => {
      const seeded = await seedPeopleSession({
        userPrompt: 'A slow drive along the coast',
        photos: { Thomas: 1, Jonas: 2, Anna: 2 },
      });

      const { sent, attempt } = await referencesFor(seeded, 'Anna and Jonas on a hill');

      expect(sent).toHaveLength(2);
      expect(await frozenPersonIds(attempt.id)).toEqual([
        seeded.people.Jonas!.personId,
        seeded.people.Anna!.personId,
      ]);
    });

    it('a Session that includes the listener adds the owner only when the wish names the owner', async () => {
      const seeded = await seedPeopleSession({
        userPrompt: 'Me and Jonas on a roadtrip',
        photos: { Thomas: 1, Jonas: 1, Anna: 1 },
        includesListener: true,
      });

      const annaOnly = await referencesFor(seeded, 'Anna at the beach');
      expect(annaOnly.sent).toEqual(seeded.people.Anna!.photoIds);

      const withOwner = await referencesFor(seeded, 'Thomas and Anna at the beach');
      expect(await frozenPersonIds(withOwner.attempt.id)).toEqual([
        seeded.people.Thomas!.personId,
        seeded.people.Anna!.personId,
      ]);

      const [session] = await ctx.db
        .select({ includesListener: activitySessions.includesListener })
        .from(activitySessions)
        .where(eq(activitySessions.id, seeded.sessionId));
      expect(session!.includesListener).toBe(true);
    });

    it('a wish the Text AI reads as including the listener adds the owner beside the People it names', async () => {
      const seeded = await seedPeopleSession({
        userPrompt: 'Roadtrip with Jonas',
        photos: { Thomas: 1, Jonas: 1, Anna: 1 },
      });

      const { attempt } = await referencesFor(
        seeded,
        'Ich tanze mit Anna',
        'two figures dancing',
        true,
      );

      expect((await frozenPersonIds(attempt.id)).sort()).toEqual(
        [seeded.people.Thomas!.personId, seeded.people.Anna!.personId].sort(),
      );
    });

    it('a wish read as the listener alone brings only the owner, not the Session’s People', async () => {
      const seeded = await seedPeopleSession({
        userPrompt: 'Roadtrip with Jonas',
        photos: { Thomas: 1, Jonas: 1 },
      });

      const { sent } = await referencesFor(seeded, 'moi sur la plage', 'a figure on a beach', true);

      expect(sent).toEqual(seeded.people.Thomas!.photoIds);
    });

    it('a wish read as not including the listener leaves the owner out of a named scene', async () => {
      const seeded = await seedPeopleSession({
        userPrompt: 'A slow drive along the coast',
        photos: { Thomas: 1, Anna: 1 },
        includesListener: true,
      });

      const { sent } = await referencesFor(seeded, 'Anna at the beach', 'Anna on a beach', false);

      expect(sent).toEqual(seeded.people.Anna!.photoIds);
    });

    it('start without profile keeps the owner out even when the wish is read as including them', async () => {
      const seeded = await seedPeopleSession({
        userPrompt: 'Roadtrip with Jonas',
        photos: { Thomas: 1, Anna: 1 },
        skipProfile: true,
      });

      const { sent } = await referencesFor(seeded, 'me dancing with Anna', 'two dancers', true);

      expect(sent).toEqual(seeded.people.Anna!.photoIds);
    });

    it('a name only in the rewritten wish brings no photo', async () => {
      const seeded = await seedPeopleSession({
        userPrompt: 'Roadtrip with Jonas',
        photos: { Thomas: 1, Jonas: 1, Anna: 1 },
      });

      const { sent, calls } = await referencesFor(
        seeded,
        'a beach at dawn',
        'Anna strolling a pastel beach at dawn',
      );

      expect(sent).toEqual(seeded.people.Jonas!.photoIds);
      expect(calls[0]!.positivePrompt).toContain('pastel beach');
    });

    it('a name only in the typed wish still brings the photo', async () => {
      const seeded = await seedPeopleSession({
        userPrompt: 'Roadtrip with Jonas',
        photos: { Thomas: 1, Jonas: 1, Anna: 1 },
      });

      const { sent, calls } = await referencesFor(
        seeded,
        'Anna at the beach',
        'a lone figure on a pastel beach at dawn',
      );

      expect(sent).toEqual(seeded.people.Anna!.photoIds);
      expect(calls[0]!.positivePrompt).toContain('pastel beach');
    });

    it('a safe retry sends the references frozen at planning without matching again', async () => {
      const seeded = await seedPeopleSession({
        userPrompt: 'Roadtrip with Jonas',
        photos: { Thomas: 1, Jonas: 1, Anna: 1 },
      });
      const attempt = await reserveAttempt(
        seeded.ownerUserId,
        seeded.sessionId,
        'Anna at the beach',
      );
      const { provider, calls } = fakeCoverArt({
        acceptsReferences: true,
        idempotency: 'native',
        error: (call) =>
          call === 1
            ? new GeneratedImageProviderError('unavailable', 'retryable_with_same_key')
            : undefined,
      });

      await expect(
        generator(seeded.ownerUserId, provider).processRegeneration(seeded.sessionId, attempt.id),
      ).rejects.toBeInstanceOf(SessionCoverRetryableError);
      // A renamed Person would no longer match the wish; the frozen plan holds.
      await updatePerson(ctx.db, {
        ownerUserId: seeded.ownerUserId,
        personId: seeded.people.Anna!.personId,
        name: 'Annabel',
        about: '',
      });
      await expect(
        generator(seeded.ownerUserId, provider).processRegeneration(seeded.sessionId, attempt.id),
      ).resolves.toMatchObject({ status: 'ready', generatedNow: true });

      expect(calls).toHaveLength(2);
      expect(calls[1]!.references.map((reference) => reference.id)).toEqual(
        seeded.people.Anna!.photoIds,
      );
      expect(calls[0]!.references.map((reference) => reference.id)).toEqual(
        calls[1]!.references.map((reference) => reference.id),
      );
    });

    async function reserveRequest(
      seeded: { ownerUserId: string; sessionId: string },
      request: CoverRequestProvenance,
    ) {
      const coverImageId = randomUUID();
      const attempt = await reserveSessionCoverRegeneration(ctx.db, {
        id: randomUUID(),
        ownerUserId: seeded.ownerUserId,
        activitySessionId: seeded.sessionId,
        coverImageId,
        storageKey: storageKeys.generatedCover(
          seeded.ownerUserId,
          seeded.sessionId,
          coverImageId,
          'webp',
        ),
        request,
      });
      return attempt!;
    }

    it('with People photos switched off, a named Person brings no photo and none is read', async () => {
      const seeded = await seedPeopleSession({
        userPrompt: 'Roadtrip with Jonas',
        photos: { Thomas: 1, Jonas: 1, Anna: 1 },
        includesListener: true,
      });
      const attempt = await reserveRequest(seeded, {
        userGuidance: 'Anna at the beach',
        usePeopleReferences: false,
      });
      const readSpy = vi.spyOn(store.provider, 'readStream');
      const { provider, calls } = fakeCoverArt({ acceptsReferences: true });

      const result = await generator(seeded.ownerUserId, provider).processRegeneration(
        seeded.sessionId,
        attempt.id,
      );

      expect(result).toMatchObject({ status: 'ready', generatedNow: true });
      expect(calls[0]!.references).toEqual([]);
      expect(calls[0]!.positivePrompt).not.toContain('Reference treatment:');
      expect(readSpy).not.toHaveBeenCalled();
      const settled = await ledgerRow(attempt.id);
      expect(settled?.selectedReferences).toEqual([]);
      expect(settled?.plan.usePeopleReferences).toBe(false);
      readSpy.mockRestore();
    });

    it('with People photos switched on and nobody named, the owner appears on every attempt', async () => {
      const seeded = await seedPeopleSession({
        userPrompt: 'A slow drive along the coast',
        photos: { Thomas: 1, Anna: 1 },
        // `seldom` would normally roll the owner fallback; the switch wins.
        frequency: 'seldom',
      });
      const attempt = await reserveRequest(seeded, { usePeopleReferences: true });
      const { provider, calls } = fakeCoverArt({ acceptsReferences: true });

      await generator(seeded.ownerUserId, provider).processRegeneration(
        seeded.sessionId,
        attempt.id,
      );

      expect(calls[0]!.references.map((reference) => reference.id)).toEqual(
        seeded.people.Thomas!.photoIds,
      );
      expect((await ledgerRow(attempt.id))?.plan.usePeopleReferences).toBe(true);
    });

    it.each([
      ['the owner has no photo', { Anna: 1 }, false],
      ['the Session runs without profile', { Thomas: 1, Anna: 1 }, true],
    ])(
      'with People photos switched on and nobody named, %s: the cover is made without references',
      async (_case, photos, skipProfile) => {
        const seeded = await seedPeopleSession({
          userPrompt: 'A slow drive along the coast',
          photos,
          frequency: 'seldom',
          skipProfile,
        });
        const attempt = await reserveRequest(seeded, { usePeopleReferences: true });
        const { provider, calls } = fakeCoverArt({ acceptsReferences: true });

        const result = await generator(seeded.ownerUserId, provider).processRegeneration(
          seeded.sessionId,
          attempt.id,
        );

        expect(result).toMatchObject({ status: 'ready', generatedNow: true });
        expect(calls[0]!.references).toEqual([]);
        expect((await ledgerRow(attempt.id))?.selectedReferences).toEqual([]);
      },
    );

    it('with People photos switched on, a named Person without a photo leaves the cover prompt-only', async () => {
      const seeded = await seedPeopleSession({
        userPrompt: 'Roadtrip with Jonas',
        photos: { Thomas: 1, Jonas: 0, Anna: 1 },
      });
      const attempt = await reserveRequest(seeded, { usePeopleReferences: true });
      const { provider, calls } = fakeCoverArt({ acceptsReferences: true });

      const result = await generator(seeded.ownerUserId, provider).processRegeneration(
        seeded.sessionId,
        attempt.id,
      );

      expect(result).toMatchObject({ status: 'ready', generatedNow: true });
      expect(calls[0]!.references).toEqual([]);
    });

    it('never: a named Person brings no photo and the cover is made without references', async () => {
      const seeded = await seedPeopleSession({
        userPrompt: 'Roadtrip with Jonas',
        photos: { Thomas: 1, Anna: 1 },
        frequency: 'never',
      });
      const readSpy = vi.spyOn(store.provider, 'readStream');

      const { sent, calls } = await referencesFor(seeded, 'Anna at the beach');

      expect(sent).toEqual([]);
      expect(calls[0]!.positivePrompt).not.toContain('Reference treatment:');
      expect(readSpy).not.toHaveBeenCalled();
      readSpy.mockRestore();
    });

    it("start without profile: the owner's name brings no photo, another named Person still does", async () => {
      const seeded = await seedPeopleSession({
        userPrompt: 'Roadtrip with Jonas',
        photos: { Thomas: 1, Jonas: 1, Anna: 1 },
        skipProfile: true,
      });

      const both = await referencesFor(seeded, 'Thomas and Anna at the beach');
      expect(both.sent).toEqual(seeded.people.Anna!.photoIds);

      const ownerOnly = await referencesFor(seeded, 'Thomas at the beach');
      expect(ownerOnly.sent).toEqual([]);
    });

    it('a named Person without photos does not block the reroll', async () => {
      const seeded = await seedPeopleSession({
        userPrompt: 'Roadtrip with Jonas',
        photos: { Thomas: 1, Jonas: 1, Mia: 0 },
      });

      const { sent } = await referencesFor(seeded, 'Mia at the beach');

      expect(sent).toEqual([]);
    });

    it('settles references_unsupported unpaid when the image model accepts no reference photos', async () => {
      const seeded = await seedPeopleSession({
        userPrompt: 'A slow drive along the coast',
        photos: { Anna: 1 },
      });
      await updateUsageLimits(ctx.db, { generatedCoversPerDay: 1 });
      const refused = await reserveAttempt(
        seeded.ownerUserId,
        seeded.sessionId,
        'Anna at the beach',
      );
      const { provider, calls } = fakeCoverArt({ acceptsReferences: false });

      const result = await generator(seeded.ownerUserId, provider).processRegeneration(
        seeded.sessionId,
        refused.id,
      );

      expect(result).toMatchObject({ status: 'fallback', reason: 'references_unsupported' });
      expect(calls).toHaveLength(0);
      expect(await ledgerRow(refused.id)).toMatchObject({
        state: 'not_admitted',
        possiblyPaid: false,
        failureCategory: 'references_unsupported',
      });
      const next = await reserveAttempt(seeded.ownerUserId, seeded.sessionId, 'darker, more neon');
      await expect(
        generator(seeded.ownerUserId, provider).processRegeneration(seeded.sessionId, next.id),
      ).resolves.toMatchObject({ status: 'ready', generatedNow: true });
    });

    it('a Person named like a common word matches that word in the wish', async () => {
      // Decided: exact names match whole words, so "rose" finds Rose.
      const seeded = await seedPeopleSession({
        userPrompt: 'A slow drive along the coast',
        photos: { Thomas: 1, Rose: 1 },
      });

      const { sent } = await referencesFor(seeded, 'one red rose');

      expect(sent).toEqual(seeded.people.Rose!.photoIds);
    });
  });
});
