import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activitySessions,
  coverImages,
  createPerson,
  deletePersonReferencePhoto,
  deleteSession,
  ensureOwnerPerson,
  insertPersonReferencePhoto,
  sessionCoverGenerations,
  PLACEHOLDER_COVER_ID,
  personReferencePhotos,
  providerJobs,
  updatePerson,
  withOwnerCoverArtLock,
  updateUsageLimits,
  listenerProfiles,
  setMemberDisabled,
  userProfiles,
  type CoverImageRow,
} from '@liedmotif/db';
import { seedPlaceholderCover } from '@liedmotif/db/seed';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createSession,
  createTrack,
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
import {
  createMockStorageProvider,
  readAllBytes,
  storageKeys,
  type MockStorage,
} from '@liedmotif/storage';
import {
  createSessionCoverGenerator,
  SessionCoverRetryableError,
  type SessionCoverGenerator,
  type SessionCoverGeneratorDeps,
} from './session-cover-generator';
import { buildSessionCoverPlan } from './cover-plan';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const FIXTURE_TABLES = [
  ...GENERATION_FIXTURE_TABLES,
  'cover_images',
  'listener_profiles',
  'person_reference_photos',
  'people',
  'app_settings',
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
    supportsReferences?: boolean;
    maxReferences?: number;
    maxReferenceBytes?: number;
    referenceMediaTypes?: Array<'image/jpeg' | 'image/png' | 'image/webp'>;
    maxPromptCharacters?: number;
    onGenerate?: () => Promise<void>;
    musicTaskSource?: { musicProviderKey: string };
  } = {},
) {
  const calls: GeneratedImageRequest[] = [];
  const capabilities: GeneratedImageCapabilities = {
    provider: { providerType: 'image', providerKey: 'fake-images', model: 'test/cover-model' },
    maxPromptCharacters: behavior.maxPromptCharacters ?? 8_000,
    exclusions: 'inline',
    nativeSeed: true,
    idempotency: behavior.idempotency ?? 'absent',
    references:
      behavior.supportsReferences === false
        ? null
        : {
            roles: ['subject'],
            maxCount: behavior.maxReferences ?? 3,
            multiSubjectIdentity: false,
            mediaTypes: behavior.referenceMediaTypes ?? ['image/jpeg', 'image/png', 'image/webp'],
            maxBytesPerReference: behavior.maxReferenceBytes ?? 2_000_000,
            maxTotalBytes: 4_000_000,
          },
    squareOutput: 'native',
    maxCandidates: 1,
    costReporting: true,
    ...(behavior.musicTaskSource ? { musicTaskSource: behavior.musicTaskSource } : {}),
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
      await behavior.onGenerate?.();
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
        downgradeCodes:
          capabilities.idempotency === 'absent'
            ? ['exclusions_inlined', 'idempotency_unavailable']
            : ['exclusions_inlined'],
      };
    },
    async validateCredentials() {
      return { ok: true };
    },
  };
  return { provider, calls };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describeIfDb('SessionCoverGenerator', () => {
  let ctx: TestDb;
  let store: MockStorage;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-session-cover-generator-test');
    store = createMockStorageProvider();
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
    await store?.cleanup();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, FIXTURE_TABLES);
  });

  async function seedSession() {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: SNAPSHOT,
      title: 'Instrumental Session',
    });
    return { ownerUserId, sessionId };
  }

  function generator(
    ownerUserId: string,
    imageProvider: GeneratedImageProvider | null,
    overrides: Partial<SessionCoverGeneratorDeps> = {},
  ): SessionCoverGenerator & {
    embedded: string[];
    logs: Array<{ level: 'info' | 'warn'; message: string; fields?: Record<string, unknown> }>;
  } {
    const embedded: string[] = [];
    const logs: Array<{
      level: 'info' | 'warn';
      message: string;
      fields?: Record<string, unknown>;
    }> = [];
    const instance = createSessionCoverGenerator({
      db: ctx.db,
      ownerUserId,
      imageProvider,
      storage: store.provider,
      // The fixture bytes are not a real image; the sharp gate would reject them.
      evaluateCover: async () => ({ ok: true, width: 1024, height: 1024 }),
      normalizeCover: async (bytes) => bytes,
      measureCover: async () => ({ width: 1024, height: 1024 }),
      metadataQueue: {
        enqueue: async (trackId) => {
          embedded.push(trackId);
        },
      },
      logger: {
        info: (message, fields) => logs.push({ level: 'info', message, fields }),
        warn: (message, fields) => logs.push({ level: 'warn', message, fields }),
      },
      clock: { now: () => new Date('2026-07-12T12:00:00.000Z') },
      textLlmConfigured: false,
      ...overrides,
    });
    return Object.assign(instance, { embedded, logs });
  }

  async function sessionCoverId(sessionId: string): Promise<string | null> {
    const [row] = await ctx.db
      .select({ coverImageId: activitySessions.coverImageId })
      .from(activitySessions)
      .where(eq(activitySessions.id, sessionId));
    return row!.coverImageId;
  }

  async function generatedCoverRows(): Promise<CoverImageRow[]> {
    return ctx.db.select().from(coverImages).where(eq(coverImages.sourceType, 'generated'));
  }

  it('no-ops when no image provider is configured (no cover lands)', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    const d = generator(ownerUserId, null);
    const result = await d.ensureGenerated(sessionId);
    expect(result).toEqual({
      status: 'fallback',
      reason: 'provider_unconfigured',
      coverImageId: null,
    });
    expect(await sessionCoverId(sessionId)).toBeNull();
  });

  it('generates, stores, inserts the cover row, points the session at it, and retags MP3s', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
    const mp3TrackId = await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      audioStorageKey: 'tracks/fixture/final.mp3',
    });

    const { provider, calls } = fakeCoverArt();
    const d = generator(ownerUserId, provider);
    const result = await d.ensureGenerated(sessionId);

    expect(result).toMatchObject({ status: 'ready', generatedNow: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      purpose: 'session-cover',
      count: 1,
      target: { shape: 'square', quality: 'high' },
      seed: expect.any(Number),
    });
    expect(calls[0]!.positivePrompt).toMatch(/^Deliverable:/);
    expect(calls[0]!.positivePrompt).toContain('Session Name: "Instrumental Session"');
    expect(calls[0]!.positivePrompt.indexOf('Session Name:')).toBeLessThan(
      calls[0]!.positivePrompt.indexOf('Primary style:'),
    );
    expect(calls[0]!.exclusions.join(' ')).toContain('watermarks');

    const rows = await generatedCoverRows();
    expect(rows).toHaveLength(1);
    const cover = rows[0]!;
    expect(await sessionCoverId(sessionId)).toBe(cover.id);
    expect(cover.storageKey).toBe(
      storageKeys.generatedCover(ownerUserId, sessionId, cover.id, 'webp'),
    );
    const stat = await store.provider.stat(cover.storageKey);
    expect(stat?.byteSize).toBe(IMAGE_BYTES.length);

    const [ledger] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(ledger).toMatchObject({
      ownerUserId,
      activitySessionId: sessionId,
      state: 'ready',
      possiblyPaid: true,
      coverImageId: cover.id,
      storageKey: storageKeys.generatedCover(ownerUserId, sessionId, cover.id, 'webp'),
      seed: String(calls[0]!.seed),
    });
    expect(ledger!.plan).toMatchObject({ sessionName: 'Instrumental Session' });

    // Provenance carries safe metadata only — ids/cost, never image data or prompts.
    const provenance = cover.provenance as Record<string, unknown>;
    expect(provenance.ownerUserId).toBe(ownerUserId);
    expect(provenance.activitySessionId).toBe(sessionId);
    expect(provenance.costUsd).toBe(0.01);
    expect(provenance.branded).toBe(false);
    expect(provenance.generatedAt).toBe('2026-07-12T12:00:00.000Z');
    expect(JSON.stringify(provenance)).not.toContain('base64');
    expect(provenance.prompt).toBeUndefined();
    expect(JSON.stringify(provenance)).not.toContain('lofi'); // no prompt/style text

    // The session's existing final MP3 is queued for a retag with the new cover.
    expect(d.embedded).toEqual([mp3TrackId]);
    expect(d.logs).toEqual([
      {
        level: 'info',
        message: 'generated session cover',
        fields: { activitySessionId: sessionId, coverImageId: cover.id },
      },
    ]);
    expect(JSON.stringify(d.logs)).not.toMatch(/lofi|prompt|reference|bytes/i);
  });

  it('runs the paid provider call outside the owner cover lock and its transaction', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    let stateDuringGenerate: string | undefined;
    let lockFreeDuringGenerate = false;
    const { provider } = fakeCoverArt({
      onGenerate: async () => {
        // The claim must already be COMMITTED (visible from another connection),
        // proving the provider call is not inside the claiming transaction…
        const [row] = await ctx.db
          .select({ state: sessionCoverGenerations.state })
          .from(sessionCoverGenerations)
          .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
        stateDuringGenerate = row!.state;
        // …and the owner cover lock must be free while the provider runs — a
        // regression that re-wraps the call would deadlock this acquisition
        // (the test then fails on its timeout).
        lockFreeDuringGenerate = await withOwnerCoverArtLock(ctx.db, ownerUserId, async () => true);
      },
    });
    const result = await generator(ownerUserId, provider).ensureGenerated(sessionId);
    expect(result).toMatchObject({ status: 'ready' });
    expect(stateDuringGenerate).toBe('submitting');
    expect(lockFreeDuringGenerate).toBe(true);
  });

  it('a state that moved on during the unlocked provider call wins — the stale recording no-ops', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    const settledElsewhere = new Date('2026-07-12T12:00:30.000Z');
    const { provider } = fakeCoverArt({
      onGenerate: async () => {
        // A concurrent settlement (recovery cron, deletion) lands while the
        // provider call is in flight, after the claim's lock was released.
        await ctx.db
          .update(sessionCoverGenerations)
          .set({ state: 'not_admitted', settledAt: settledElsewhere, updatedAt: settledElsewhere })
          .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
      },
    });
    await generator(ownerUserId, provider).ensureGenerated(sessionId);
    const [ledger] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    // The expectedStates-guarded transitions refused to clobber the settled row.
    expect(ledger!.state).toBe('not_admitted');
    expect(ledger!.settledAt).toEqual(settledElsewhere);
  });

  it('is idempotent per session — a retry never buys a second cover', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    const { provider, calls } = fakeCoverArt();
    await generator(ownerUserId, provider).ensureGenerated(sessionId);
    const again = await generator(ownerUserId, provider).ensureGenerated(sessionId);
    expect(again).toMatchObject({ status: 'ready', generatedNow: false });
    expect(calls).toHaveLength(1);
    expect(await generatedCoverRows()).toHaveLength(1);
  });

  it('returns pending to a concurrent duplicate and performs exactly one provider call', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    const release = deferred();
    const entered = deferred();
    const { provider, calls } = fakeCoverArt({
      onGenerate: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const first = generator(ownerUserId, provider).ensureGenerated(sessionId);
    await entered.promise;
    await expect(generator(ownerUserId, provider).ensureGenerated(sessionId)).resolves.toEqual({
      status: 'pending',
    });
    expect(calls).toHaveLength(1);
    release.resolve();
    await expect(first).resolves.toMatchObject({ status: 'ready', generatedNow: true });
    expect(calls).toHaveLength(1);
  });

  it('serializes Session deletion with submission and refuses deletion while storage is live', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    await ctx.db
      .update(activitySessions)
      .set({ status: 'stopped' })
      .where(eq(activitySessions.id, sessionId));
    const providerRelease = deferred();
    const providerEntered = deferred();
    const normalizeRelease = deferred();
    const normalizeEntered = deferred();
    const { provider, calls } = fakeCoverArt({
      onGenerate: async () => {
        providerEntered.resolve();
        await providerRelease.promise;
      },
    });
    const generation = generator(ownerUserId, provider, {
      normalizeCover: async (bytes) => {
        normalizeEntered.resolve();
        await normalizeRelease.promise;
        return bytes;
      },
    }).ensureGenerated(sessionId);
    await providerEntered.promise;
    let deletionResolved = false;
    const deletion = deleteSession(ctx.db, { ownerUserId, sessionId }).then((result) => {
      deletionResolved = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(deletionResolved).toBe(false);
    providerRelease.resolve();
    await normalizeEntered.promise;
    await expect(deletion).resolves.toEqual({ ok: true, id: sessionId, deferred: true });
    normalizeRelease.resolve();
    await expect(generation).resolves.toMatchObject({ status: 'ready' });
    expect(calls).toHaveLength(1);
  });

  it('releases the planning lock before provider I/O and live reservations enforce the owner limit', async () => {
    const { ownerUserId, sessionId: firstSessionId } = await seedSession();
    await ctx.db
      .update(activitySessions)
      .set({ status: 'stopped' })
      .where(eq(activitySessions.id, firstSessionId));
    const secondSessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: SNAPSHOT,
      title: 'Second Named Session',
    });
    await updateUsageLimits(ctx.db, { generatedCoversPerDay: 1, generatedCoversPerMonth: 1 });
    const release = deferred();
    const entered = deferred();
    const { provider, calls } = fakeCoverArt({
      onGenerate: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const first = generator(ownerUserId, provider).ensureGenerated(firstSessionId);
    await entered.promise;
    const second = await generator(ownerUserId, provider).ensureGenerated(secondSessionId);
    expect(second).toMatchObject({ status: 'fallback', reason: 'not_admitted' });
    const [secondLedger] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, secondSessionId));
    expect(secondLedger).toMatchObject({ state: 'not_admitted', possiblyPaid: false });
    expect(calls).toHaveLength(1);
    release.resolve();
    await first;
  });

  it('serializes owner history selection so concurrent Sessions avoid the same fingerprint', async () => {
    const ownerUserId = await createUser(ctx.db);
    const firstRelease = deferred();
    const secondRelease = deferred();
    const firstEntered = deferred();
    const secondEntered = deferred();
    let enteredCount = 0;
    const { provider, calls } = fakeCoverArt({
      onGenerate: async () => {
        enteredCount += 1;
        if (enteredCount === 1) firstEntered.resolve();
        if (enteredCount === 2) secondEntered.resolve();
        await (enteredCount === 1 ? firstRelease.promise : secondRelease.promise);
      },
    });
    const capabilities = await provider.getCapabilities();
    const byFingerprint = new Map<string, string>();
    let collidingSessionIds: [string, string] | null = null;
    // The bound sits above the first deterministic fingerprint collision for
    // this fixture (index 192 with the current minimal grammar axis space).
    for (let index = 0; index < 256 && !collidingSessionIds; index += 1) {
      const sessionId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const planned = buildSessionCoverPlan({
        textLlmConfigured: false,
        sessionId,
        sessionName: 'Same Rain Name',
        coverConcept: null,
        coverStyle: 'minimal',
        customDefinition: null,
        snapshot: SNAPSHOT,
        capabilities,
        referenceTreatment: null,
      });
      expect(planned.ok).toBe(true);
      if (!planned.ok) continue;
      const fingerprint = JSON.stringify(planned.fingerprint);
      const existing = byFingerprint.get(fingerprint);
      if (existing) collidingSessionIds = [existing, sessionId];
      else byFingerprint.set(fingerprint, sessionId);
    }
    expect(collidingSessionIds).not.toBeNull();
    const [firstSessionId, secondSessionId] = collidingSessionIds!;
    await ctx.db.insert(activitySessions).values(
      [firstSessionId, secondSessionId].map((id) => ({
        id,
        ownerUserId,
        status: 'stopped' as const,
        sessionStyleSnapshot: SNAPSHOT,
        coverStyle: 'minimal' as const,
        title: 'Same Rain Name',
      })),
    );

    const first = generator(ownerUserId, provider).ensureGenerated(firstSessionId);
    await firstEntered.promise;
    const second = generator(ownerUserId, provider).ensureGenerated(secondSessionId);
    firstRelease.resolve();
    await expect(first).resolves.toMatchObject({ status: 'ready' });
    await secondEntered.promise;

    const ledgers = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.ownerUserId, ownerUserId));
    expect(ledgers).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.count === 1)).toBe(true);

    secondRelease.resolve();
    await expect(second).resolves.toMatchObject({ status: 'ready' });
    expect(ledgers[0]!.fingerprint).not.toEqual(ledgers[1]!.fingerprint);
  });

  it.each([
    ['invalid name', null, 8_000, 'invalid_session_name'],
    ['unsupported prompt', 'A Name That Must Stay Exact', 120, 'unsupported_capability'],
  ] as const)(
    'persists %s as an idempotent terminal result',
    async (_case, title, maxPromptCharacters, reason) => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, {
        ownerUserId,
        styleSnapshot: SNAPSHOT,
        title,
      });
      const { provider, calls } = fakeCoverArt({ maxPromptCharacters });
      await expect(
        generator(ownerUserId, provider).ensureGenerated(sessionId),
      ).resolves.toMatchObject({
        status: 'fallback',
        reason,
      });
      await expect(
        generator(ownerUserId, provider).ensureGenerated(sessionId),
      ).resolves.toMatchObject({
        status: 'fallback',
        reason,
      });
      expect(calls).toHaveLength(0);
      const [ledger] = await ctx.db
        .select()
        .from(sessionCoverGenerations)
        .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
      expect(ledger).toMatchObject({ state: 'not_admitted', failureCategory: reason });
    },
  );

  it('skips when cover generation is disabled in the usage limits', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    await updateUsageLimits(ctx.db, { tailoredCoverArtEnabled: false });
    const { provider, calls } = fakeCoverArt();
    const result = await generator(ownerUserId, provider).ensureGenerated(sessionId);
    expect(result).toMatchObject({ status: 'fallback', reason: 'generation_disabled' });
    expect(calls).toHaveLength(0);
  });

  it('skips without calling the provider when the cover limit is exhausted', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    await updateUsageLimits(ctx.db, { generatedCoversPerDay: 0 });
    const { provider, calls } = fakeCoverArt();
    const result = await generator(ownerUserId, provider).ensureGenerated(sessionId);
    expect(result).toMatchObject({ status: 'fallback', reason: 'not_admitted' });
    expect(calls).toHaveLength(0);
    expect(await sessionCoverId(sessionId)).toBeNull();
  });

  it('exits cleanly when the session does not exist', async () => {
    const ownerUserId = await createUser(ctx.db);
    const { provider, calls } = fakeCoverArt();
    const result = await generator(ownerUserId, provider).ensureGenerated(
      '00000000-0000-4000-8000-000000000000',
    );
    expect(result.status).toBe('missing');
    expect(calls).toHaveLength(0);
  });

  it('returns missing when the Session belongs to another owner', async () => {
    const ownerUserId = await createUser(ctx.db);
    const otherOwnerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId: otherOwnerUserId });
    const { provider, calls } = fakeCoverArt();

    await expect(generator(ownerUserId, provider).ensureGenerated(sessionId)).resolves.toEqual({
      status: 'missing',
    });
    expect(calls).toHaveLength(0);
  });

  it('wraps a pre-submission database failure in a sanitized retryable error', async () => {
    const rawDetail = 'database password=secret-db-value';
    const brokenDb = {
      select() {
        throw new Error(rawDetail);
      },
    } as never;
    const instance = createSessionCoverGenerator({
      db: brokenDb,
      ownerUserId: 'better-auth-text-owner-id',
      imageProvider: null,
      storage: store.provider,
      metadataQueue: { enqueue: async () => undefined },
      logger: { info: () => undefined, warn: () => undefined },
      clock: { now: () => new Date('2026-07-12T12:00:00.000Z') },
      textLlmConfigured: false,
    });

    const error = await instance.ensureGenerated(crypto.randomUUID()).catch((caught) => caught);
    expect(error).toBeInstanceOf(SessionCoverRetryableError);
    expect(error).toMatchObject({
      name: 'SessionCoverRetryableError',
      message: 'Session Cover generation is temporarily unavailable.',
    });
    expect(JSON.stringify(error)).not.toContain(rawDetail);
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('settles a non-database infrastructure failure without exposing its detail', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    const sensitiveDetail = 'private clock implementation detail';
    const d = generator(ownerUserId, null, {
      clock: {
        now() {
          throw new Error(sensitiveDetail);
        },
      },
    });

    const result = await d.ensureGenerated(sessionId);
    expect(result).toEqual({
      status: 'fallback',
      reason: 'provider_unavailable',
      coverImageId: null,
    });
    expect(JSON.stringify(d.logs)).not.toContain(sensitiveDetail);
  });

  const referencePersonIds = new Map<string, string>();

  async function seedReferenceForPerson(ownerUserId: string, personId: string): Promise<string> {
    const referenceId = crypto.randomUUID();
    const storageKey = storageKeys.personReferencePhoto(ownerUserId, personId, referenceId, 'webp');
    await store.provider.write({
      key: storageKey,
      body: new Uint8Array([1, 2, 3, 4]),
      mimeType: 'image/webp',
    });
    const result = await insertPersonReferencePhoto(ctx.db, {
      id: referenceId,
      ownerUserId,
      personId,
      storageProvider: 'local-fs',
      storageKey,
      mediaType: 'image/webp',
      byteSize: 4,
    });
    expect(result.inserted).toBe(true);
    referencePersonIds.set(referenceId, personId);
    return referenceId;
  }

  async function seedReference(ownerUserId: string, personName = 'John'): Promise<string> {
    const owner = await ensureOwnerPerson(ctx.db, ownerUserId);
    const person =
      owner.name === personName
        ? owner
        : await updatePerson(ctx.db, {
            ownerUserId,
            personId: owner.id,
            name: personName,
            about: owner.about,
          });
    expect(person).not.toBeNull();
    return seedReferenceForPerson(ownerUserId, person!.id);
  }

  async function seedMultiPersonSession(names = ['John', 'Julia', 'Amina']) {
    const ownerUserId = await createUser(ctx.db);
    const owner = await ensureOwnerPerson(ctx.db, ownerUserId);
    const renamedOwner = (await updatePerson(ctx.db, {
      ownerUserId,
      personId: owner.id,
      name: names[0]!,
      about: 'PRIVATE_OWNER_CONTEXT',
    }))!;
    const configuredPeople = [renamedOwner];
    for (const name of names.slice(1)) {
      configuredPeople.push(
        await createPerson(ctx.db, {
          ownerUserId,
          name,
          about: `PRIVATE_${name.toUpperCase()}_CONTEXT`,
        }),
      );
    }
    const referenceIds: string[] = [];
    for (const person of configuredPeople) {
      referenceIds.push(await seedReferenceForPerson(ownerUserId, person.id));
    }
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: SNAPSHOT,
      title: `${names.join(', ')} Together`,
    });
    await ctx.db
      .update(activitySessions)
      .set({ userPrompt: `A joyful homecoming for ${names.join(', ')}` })
      .where(eq(activitySessions.id, sessionId));
    return { ownerUserId, sessionId, people: configuredPeople, referenceIds };
  }

  async function seedStoppedSessionWithId(
    ownerUserId: string,
    sessionId: string,
    coverStyle: 'minimal' | 'drawing' = 'minimal',
  ): Promise<void> {
    await ctx.db.insert(activitySessions).values({
      id: sessionId,
      ownerUserId,
      status: 'stopped',
      title: 'Identity in Context',
      sessionStyleSnapshot: SNAPSHOT,
      coverStyle,
    });
  }

  it('never frequency: hard opt-out — no reference rows or bytes are read', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    await ctx.db.insert(listenerProfiles).values({ ownerUserId, coverReferenceFrequency: 'never' });
    await seedReference(ownerUserId);
    const readSpy = vi.spyOn(store.provider, 'readStream');

    const { provider, calls } = fakeCoverArt();
    const result = await generator(ownerUserId, provider).ensureGenerated(sessionId);
    expect(result).toMatchObject({ status: 'ready', generatedNow: true });
    expect(calls[0]!.references).toEqual([]);
    expect(calls[0]!.positivePrompt).not.toContain('Reference treatment:');
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();
  });

  it('persists deterministic always, regularly, seldom, and never decisions per Session', async () => {
    const ownerUserId = await createUser(ctx.db, { id: 'reference-frequency-owner' });
    const referenceId = await seedReference(ownerUserId);
    const personId = referencePersonIds.get(referenceId)!;
    const cases = [
      ['always', '00000000-0000-4000-8000-000000000000', true],
      ['regularly', '00000000-0000-4000-8000-000000000002', true],
      ['seldom', '00000000-0000-4000-8000-000000000007', true],
      ['never', '00000000-0000-4000-8000-000000000004', false],
    ] as const;
    const { provider, calls } = fakeCoverArt();
    const instance = generator(ownerUserId, provider);

    for (const [frequency, sessionId, included] of cases) {
      await ctx.db
        .insert(listenerProfiles)
        .values({ ownerUserId, coverReferenceFrequency: frequency })
        .onConflictDoUpdate({
          target: listenerProfiles.ownerUserId,
          set: { coverReferenceFrequency: frequency },
        });
      await seedStoppedSessionWithId(ownerUserId, sessionId);
      await instance.ensureGenerated(sessionId);
      expect(calls.at(-1)!.references).toEqual(
        included ? [expect.objectContaining({ id: referenceId, role: 'subject' })] : [],
      );
      const [ledger] = await ctx.db
        .select({ selectedReferences: sessionCoverGenerations.selectedReferences })
        .from(sessionCoverGenerations)
        .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
      expect(ledger?.selectedReferences).toEqual(
        included ? [{ id: referenceId, personId, role: 'subject' }] : [],
      );
    }
    expect(calls).toHaveLength(cases.length);
  });

  it('uses a mentioned cover reference even when the fallback frequency roll excludes it', async () => {
    const ownerUserId = await createUser(ctx.db, { id: 'reference-frequency-owner' });
    const sessionId = '00000000-0000-4000-8000-000000000000';
    const referenceId = await seedReference(ownerUserId);
    await ctx.db
      .insert(listenerProfiles)
      .values({ ownerUserId, coverReferenceFrequency: 'seldom' });
    await ctx.db.insert(activitySessions).values({
      id: sessionId,
      ownerUserId,
      status: 'stopped',
      title: 'A Song for John',
      userPrompt: 'Make a joyful song about John returning home',
      sessionStyleSnapshot: SNAPSHOT,
      coverStyle: 'minimal',
    });
    const { provider, calls } = fakeCoverArt();

    await generator(ownerUserId, provider).ensureGenerated(sessionId);

    expect(calls[0]!.references).toEqual([
      expect.objectContaining({ id: referenceId, role: 'subject' }),
    ]);
  });

  it('skip-profile session: the owner stays out even when named and the frequency allows them', async () => {
    const ownerUserId = await createUser(ctx.db, { id: 'reference-frequency-owner' });
    const sessionId = '00000000-0000-4000-8000-000000000000';
    await seedReference(ownerUserId);
    await ctx.db
      .insert(listenerProfiles)
      .values({ ownerUserId, coverReferenceFrequency: 'always' });
    await ctx.db.insert(activitySessions).values({
      id: sessionId,
      ownerUserId,
      status: 'stopped',
      title: 'A Song for John',
      userPrompt: 'Make a joyful song about John returning home',
      sessionStyleSnapshot: SNAPSHOT,
      coverStyle: 'minimal',
      skipProfile: true,
    });
    const readSpy = vi.spyOn(store.provider, 'readStream');
    const { provider, calls } = fakeCoverArt();

    const result = await generator(ownerUserId, provider).ensureGenerated(sessionId);

    expect(result).toMatchObject({ status: 'ready', generatedNow: true });
    expect(calls[0]!.references).toEqual([]);
    expect(calls[0]!.positivePrompt).not.toContain('Reference treatment:');
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();
  });

  it('skip-profile session: a named Person other than the owner still appears', async () => {
    const { ownerUserId, sessionId, referenceIds } = await seedMultiPersonSession();
    await ctx.db
      .update(activitySessions)
      // Even a stored "includes the listener" cannot bring the owner back.
      .set({
        userPrompt: 'A birthday song for Julia, from John',
        skipProfile: true,
        includesListener: true,
      })
      .where(eq(activitySessions.id, sessionId));
    const { provider, calls } = fakeCoverArt();

    await generator(ownerUserId, provider).ensureGenerated(sessionId);

    // John is the owner Person: named, with a photo, and still left out.
    expect(calls[0]!.references.map((reference) => reference.id)).toEqual([referenceIds[1]]);
  });

  it('settles without spending when the configured model cannot accept references', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    await ctx.db
      .insert(listenerProfiles)
      .values({ ownerUserId, coverReferenceFrequency: 'always' });
    const referenceId = await seedReference(ownerUserId);
    const personId = referencePersonIds.get(referenceId)!;
    const readSpy = vi.spyOn(store.provider, 'readStream');

    const { provider, calls } = fakeCoverArt({ supportsReferences: false });
    const result = await generator(ownerUserId, provider).ensureGenerated(sessionId);
    expect(result).toMatchObject({ status: 'fallback', reason: 'references_unsupported' });
    expect(calls).toHaveLength(0);
    expect(readSpy).not.toHaveBeenCalled();
    const [ledger] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(ledger).toMatchObject({
      state: 'not_admitted',
      possiblyPaid: false,
      failureCategory: 'references_unsupported',
      selectedReferences: [{ id: referenceId, personId, role: 'subject' }],
    });
    readSpy.mockRestore();
  });

  it('always frequency: sends the uploaded references and prompts for the person', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    await ctx.db
      .insert(listenerProfiles)
      .values({ ownerUserId, coverReferenceFrequency: 'always' });
    const referenceId = await seedReference(ownerUserId);

    const { provider, calls } = fakeCoverArt();
    const result = await generator(ownerUserId, provider).ensureGenerated(sessionId);
    expect(result).toMatchObject({ status: 'ready', generatedNow: true });
    expect(calls[0]!.references).toHaveLength(1);
    expect(calls[0]!.references[0]!.id).toBe(referenceId);
    expect(calls[0]!.references[0]!.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(calls[0]!.positivePrompt).toContain('Reference treatment:');
    expect(calls[0]!.positivePrompt).not.toContain('John in a black hoodie');

    const [cover] = await generatedCoverRows();
    expect((cover!.provenance as Record<string, unknown>).referenceIds).toEqual([referenceId]);
  });

  it('sends all three ordered photos for one owner-scoped Person on every retryable plan', async () => {
    const ownerUserId = await createUser(ctx.db, { id: 'reference-rotation-owner' });
    const otherOwnerUserId = await createUser(ctx.db, { id: 'other-reference-owner' });
    await ctx.db
      .insert(listenerProfiles)
      .values({ ownerUserId, coverReferenceFrequency: 'always' });
    const ownerReferences = new Set([
      await seedReference(ownerUserId),
      await seedReference(ownerUserId),
      await seedReference(ownerUserId),
    ]);
    const foreignReference = await seedReference(otherOwnerUserId);
    const sessionIds = [
      '10000000-0000-4000-8000-000000000000',
      '10000000-0000-4000-8000-000000000001',
    ];
    await seedStoppedSessionWithId(ownerUserId, sessionIds[0]!, 'minimal');
    await seedStoppedSessionWithId(ownerUserId, sessionIds[1]!, 'drawing');
    await ctx.db
      .update(activitySessions)
      .set({ userPrompt: 'A portrait of John in the requested scene' })
      .where(eq(activitySessions.ownerUserId, ownerUserId));
    const { provider, calls } = fakeCoverArt({ maxReferences: 3 });
    const instance = generator(ownerUserId, provider);

    await instance.ensureGenerated(sessionIds[0]!);
    await instance.ensureGenerated(sessionIds[1]!);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.references).toHaveLength(3);
      expect(new Set(call.references.map((reference) => reference.id))).toEqual(ownerReferences);
      expect(call.references.every((reference) => reference.role === 'subject')).toBe(true);
      expect(call.references.map((reference) => reference.id)).not.toContain(foreignReference);
    }
    expect(calls[0]!.references.map((reference) => reference.id)).toEqual(
      calls[1]!.references.map((reference) => reference.id),
    );
    const treatments = calls.map(
      (call) => call.positivePrompt.match(/^Reference treatment: (.+)$/m)?.[1],
    );
    expect(treatments[0]).toMatch(/preserve recognizable/i);
    expect(treatments[1]).toMatch(/preserve recognizable/i);
    expect(treatments[1]).toMatch(/drawn|redraw/i);
    expect(treatments[1]).not.toBe(treatments[0]);
  });

  it('freezes a deterministic endpoint-limited subset before provider I/O', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    await ctx.db
      .insert(listenerProfiles)
      .values({ ownerUserId, coverReferenceFrequency: 'always' });
    await seedReference(ownerUserId);
    await seedReference(ownerUserId);
    await seedReference(ownerUserId);
    const { provider, calls } = fakeCoverArt({ maxReferences: 2 });

    await generator(ownerUserId, provider).ensureGenerated(sessionId);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.references).toHaveLength(2);
    const [ledger] = await ctx.db
      .select({ selectedReferences: sessionCoverGenerations.selectedReferences })
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(ledger!.selectedReferences.map((reference) => reference.id)).toEqual(
      calls[0]!.references.map((reference) => reference.id),
    );
    expect(ledger!.selectedReferences.every((reference) => reference.personId)).toBe(true);
  });

  it('freezes ordered multi-Person associations and reuses them for a safe retry', async () => {
    const { ownerUserId, sessionId, people: configuredPeople } = await seedMultiPersonSession();
    await seedReferenceForPerson(ownerUserId, configuredPeople[1]!.id);
    const { provider, calls } = fakeCoverArt({
      idempotency: 'native',
      maxReferences: 3,
      error: (attempt) =>
        attempt === 1
          ? new GeneratedImageProviderError('unavailable', 'retryable_with_same_key')
          : undefined,
    });

    await expect(
      generator(ownerUserId, provider).ensureGenerated(sessionId),
    ).rejects.toBeInstanceOf(SessionCoverRetryableError);
    await expect(
      generator(ownerUserId, provider).ensureGenerated(sessionId),
    ).resolves.toMatchObject({ status: 'ready', generatedNow: true });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.references.map((reference) => reference.id)).toEqual(
      calls[1]!.references.map((reference) => reference.id),
    );
    expect(calls[0]!.references).toHaveLength(3);
    expect(calls[0]!.positivePrompt).toMatch(
      /reference image one.*reference image two.*reference image three/i,
    );
    expect(calls[0]!.positivePrompt).not.toMatch(/PRIVATE_.*_CONTEXT/);
    const [ledger] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(ledger!.plan.selectedPersonIds).toEqual(configuredPeople.map((person) => person.id));
    expect(ledger!.selectedReferences.map((reference) => reference.personId)).toEqual(
      configuredPeople.map((person) => person.id),
    );
  });

  it('puts the owner beside the named People when the request includes the listener', async () => {
    const { ownerUserId, sessionId, people: configuredPeople } = await seedMultiPersonSession();
    // The request says "me", never the owner's name: only the stored answer of
    // the text LLM can put them on the cover.
    await ctx.db
      .update(activitySessions)
      .set({ userPrompt: 'Me, Julia and Amina on a trip to the moon', includesListener: true })
      .where(eq(activitySessions.id, sessionId));
    const { provider, calls } = fakeCoverArt({ maxReferences: 3 });

    await generator(ownerUserId, provider).ensureGenerated(sessionId);

    expect(calls[0]!.references).toHaveLength(3);
    expect(calls[0]!.positivePrompt).toContain(
      'subject one is also the request\'s own "I", "me" or "we"',
    );
    const [ledger] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(ledger!.plan.selectedPersonIds).toEqual(configuredPeople.map((person) => person.id));
  });

  it('plans an Auto cover in the preset the text LLM picked for the Session', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    await ctx.db
      .update(activitySessions)
      .set({ coverStyle: 'auto', autoCoverStyle: 'manga' })
      .where(eq(activitySessions.id, sessionId));
    const { provider } = fakeCoverArt();

    await generator(ownerUserId, provider, { textLlmConfigured: true }).ensureGenerated(sessionId);

    const [ledger] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(ledger!.plan).toMatchObject({ selectedStyle: 'auto', resolvedStyle: 'manga' });
  });

  it('records the picked preset as an Auto cover’s style when planning fails', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    await ctx.db
      .update(activitySessions)
      .set({ title: null, coverStyle: 'auto', autoCoverStyle: 'manga' })
      .where(eq(activitySessions.id, sessionId));
    const { provider } = fakeCoverArt();

    await expect(
      generator(ownerUserId, provider, { textLlmConfigured: true }).ensureGenerated(sessionId),
    ).resolves.toMatchObject({ status: 'fallback', reason: 'invalid_session_name' });

    const [ledger] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(ledger!.plan).toMatchObject({ selectedStyle: 'auto', resolvedStyle: 'manga' });
  });

  it('leaves the owner off a cover whose request names only other People', async () => {
    const { ownerUserId, sessionId, people: configuredPeople } = await seedMultiPersonSession();
    await ctx.db
      .update(activitySessions)
      .set({ userPrompt: 'Julia and Amina on a trip to the moon' })
      .where(eq(activitySessions.id, sessionId));
    const { provider, calls } = fakeCoverArt({ maxReferences: 3 });

    await generator(ownerUserId, provider).ensureGenerated(sessionId);

    expect(calls[0]!.references).toHaveLength(2);
    const [ledger] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(ledger!.plan.selectedPersonIds).toEqual(
      configuredPeople.slice(1).map((person) => person.id),
    );
  });

  it('puts a Person a More Like This context names on the cover', async () => {
    const {
      ownerUserId,
      sessionId,
      people: configuredPeople,
    } = await seedMultiPersonSession(['John', 'Julia']);
    // A context-seeded Session stores the context as its prompt.
    await ctx.db
      .update(activitySessions)
      .set({ userPrompt: 'for Julia’s birthday' })
      .where(eq(activitySessions.id, sessionId));
    const { provider } = fakeCoverArt({ maxReferences: 3 });

    await generator(ownerUserId, provider).ensureGenerated(sessionId);

    const [ledger] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(ledger!.plan.selectedPersonIds).toEqual([configuredPeople[1]!.id]);
  });

  it('matches references only from user-supplied Session context', async () => {
    const ownerUserId = await createUser(ctx.db);
    const owner = await ensureOwnerPerson(ctx.db, ownerUserId);
    const julia = await createPerson(ctx.db, { ownerUserId, name: 'Julia' });
    const ownerReferenceId = await seedReferenceForPerson(ownerUserId, owner.id);
    await seedReferenceForPerson(ownerUserId, julia.id);
    await ctx.db
      .insert(listenerProfiles)
      .values({ ownerUserId, coverReferenceFrequency: 'always' });
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: SNAPSHOT,
      title: 'Julia Beneath Amber Skies',
    });
    await ctx.db
      .update(activitySessions)
      .set({
        userPrompt: 'A warm homecoming song',
        coverConcept: 'Julia crosses a sunlit threshold',
      })
      .where(eq(activitySessions.id, sessionId));
    const { provider, calls } = fakeCoverArt();

    await generator(ownerUserId, provider).ensureGenerated(sessionId);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.references.map((reference) => reference.id)).toEqual([ownerReferenceId]);
  });

  it('preflights all multi-Person capacity without provider spend or consuming the cover limit', async () => {
    const { ownerUserId, sessionId } = await seedMultiPersonSession();
    await updateUsageLimits(ctx.db, { generatedCoversPerDay: 1 });
    const { provider, calls } = fakeCoverArt({ maxReferences: 2 });

    await expect(
      generator(ownerUserId, provider).ensureGenerated(sessionId),
    ).resolves.toMatchObject({ status: 'fallback', reason: 'references_unsupported' });
    expect(calls).toHaveLength(0);
    const [rejected] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(rejected).toMatchObject({
      state: 'not_admitted',
      possiblyPaid: false,
      failureCategory: 'references_unsupported',
    });
    await ctx.db
      .update(activitySessions)
      .set({ status: 'stopped', stoppedAt: new Date('2026-07-12T12:01:00.000Z') })
      .where(eq(activitySessions.id, sessionId));

    const promptOnlySessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: SNAPSHOT,
      title: 'A Quiet Instrumental Afterward',
    });
    await expect(
      generator(ownerUserId, provider).ensureGenerated(promptOnlySessionId),
    ).resolves.toMatchObject({ status: 'ready', generatedNow: true });
    expect(calls).toHaveLength(1);
  });

  it('rejects a committed never opt-out before submission without provider spend', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    await ctx.db
      .insert(listenerProfiles)
      .values({ ownerUserId, coverReferenceFrequency: 'always' });
    const referenceId = await seedReference(ownerUserId);
    const personId = referencePersonIds.get(referenceId)!;
    const { provider, calls } = fakeCoverArt();
    let pending!: ReturnType<SessionCoverGenerator['ensureGenerated']>;

    await withOwnerCoverArtLock(ctx.db, ownerUserId, async (tx) => {
      pending = generator(ownerUserId, provider).ensureGenerated(sessionId);
      await vi.waitFor(async () => {
        const [row] = await tx
          .select({ state: sessionCoverGenerations.state })
          .from(sessionCoverGenerations)
          .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
        expect(['planned', 'submitting']).toContain(row?.state);
      });
      await tx
        .update(listenerProfiles)
        .set({ coverReferenceFrequency: 'never' })
        .where(eq(listenerProfiles.ownerUserId, ownerUserId));
    });

    await expect(pending).resolves.toMatchObject({
      status: 'fallback',
      reason: 'privacy_rejected',
    });
    expect(calls).toHaveLength(0);
    const [ledger] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(ledger).toMatchObject({
      state: 'privacy_rejected',
      possiblyPaid: false,
      submittedAt: null,
      selectedReferences: [{ id: referenceId, personId, role: 'subject' }],
    });
    expect(ledger?.plan.referenceTreatment).toMatch(/preserve recognizable/i);
  });

  it('rejects a deleted selected reference before submission without loading stale bytes', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    await ctx.db
      .insert(listenerProfiles)
      .values({ ownerUserId, coverReferenceFrequency: 'always' });
    const referenceId = await seedReference(ownerUserId);
    const personId = referencePersonIds.get(referenceId)!;
    const readSpy = vi.spyOn(store.provider, 'readStream');
    const { provider, calls } = fakeCoverArt();
    let pending!: ReturnType<SessionCoverGenerator['ensureGenerated']>;

    await withOwnerCoverArtLock(ctx.db, ownerUserId, async (tx) => {
      pending = generator(ownerUserId, provider).ensureGenerated(sessionId);
      await vi.waitFor(async () => {
        const [row] = await tx
          .select({ state: sessionCoverGenerations.state })
          .from(sessionCoverGenerations)
          .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
        expect(['planned', 'submitting']).toContain(row?.state);
      });
      await tx.delete(personReferencePhotos).where(eq(personReferencePhotos.id, referenceId));
    });

    await expect(pending).resolves.toMatchObject({
      status: 'fallback',
      reason: 'privacy_rejected',
    });
    expect(calls).toHaveLength(0);
    expect(readSpy).not.toHaveBeenCalled();
    const [ledger] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(ledger).toMatchObject({
      state: 'privacy_rejected',
      possiblyPaid: false,
      selectedReferences: [{ id: referenceId, personId, role: 'subject' }],
    });
    readSpy.mockRestore();
  });

  it('holds reference privacy until provider submission returns before deletion commits', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    await ctx.db
      .insert(listenerProfiles)
      .values({ ownerUserId, coverReferenceFrequency: 'always' });
    const referenceId = await seedReference(ownerUserId);
    const personId = referencePersonIds.get(referenceId)!;
    const providerReturn = deferred();
    const { provider, calls } = fakeCoverArt({ onGenerate: () => providerReturn.promise });
    const generation = generator(ownerUserId, provider).ensureGenerated(sessionId);
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    let deletionCommitted = false;
    const deletion = deletePersonReferencePhoto(ctx.db, {
      ownerUserId,
      personId,
      photoId: referenceId,
    }).then((result) => {
      deletionCommitted = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(deletionCommitted).toBe(false);

    providerReturn.resolve();
    await expect(generation).resolves.toMatchObject({ status: 'ready', generatedNow: true });
    await expect(deletion).resolves.toMatchObject({ id: referenceId, ownerUserId, personId });
    expect(deletionCommitted).toBe(true);
    expect(calls[0]!.references).toEqual([
      expect.objectContaining({ id: referenceId, role: 'subject' }),
    ]);
  });

  it('settles without provider spend when every selected photo exceeds endpoint limits', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    await ctx.db
      .insert(listenerProfiles)
      .values({ ownerUserId, coverReferenceFrequency: 'always' });
    const referenceId = await seedReference(ownerUserId);
    const personId = referencePersonIds.get(referenceId)!;

    const { provider, calls } = fakeCoverArt({ maxReferenceBytes: 3 });
    await expect(
      generator(ownerUserId, provider).ensureGenerated(sessionId),
    ).resolves.toMatchObject({ status: 'fallback', reason: 'references_unsupported' });

    expect(calls).toHaveLength(0);
    const [ledger] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(ledger).toMatchObject({
      failureCategory: 'references_unsupported',
      selectedReferences: [{ id: referenceId, personId, role: 'subject' }],
    });
  });

  it('settles without provider spend when every selected photo has an unsupported media type', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    await ctx.db
      .insert(listenerProfiles)
      .values({ ownerUserId, coverReferenceFrequency: 'always' });
    const referenceId = await seedReference(ownerUserId);
    const personId = referencePersonIds.get(referenceId)!;
    const { provider, calls } = fakeCoverArt({ referenceMediaTypes: ['image/png'] });

    await expect(
      generator(ownerUserId, provider).ensureGenerated(sessionId),
    ).resolves.toMatchObject({
      status: 'fallback',
      reason: 'references_unsupported',
    });
    expect(calls).toHaveLength(0);
    const [ledger] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(ledger).toMatchObject({
      failureCategory: 'references_unsupported',
      selectedReferences: [{ id: referenceId, personId, role: 'subject' }],
    });
  });

  it('settles a storage failure without exposing its raw message or buying twice', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    const { provider, calls } = fakeCoverArt();
    const d = generator(ownerUserId, provider);
    const write = vi.spyOn(store.provider, 'write').mockRejectedValueOnce(new Error('disk full'));
    const result = await d.ensureGenerated(sessionId);
    write.mockRestore();

    expect(result).toEqual({
      status: 'fallback',
      reason: 'storage_rejected',
      coverImageId: null,
    });
    expect(JSON.stringify(result)).not.toContain('disk full');
    expect(JSON.stringify(d.logs)).not.toContain('disk full');

    // The paid call is accounted in the ledger and a retry does not submit again.
    expect(calls).toHaveLength(1);
    expect(await generatedCoverRows()).toHaveLength(0);
    expect(await sessionCoverId(sessionId)).toBeNull();
    const retry = await generator(ownerUserId, provider).ensureGenerated(sessionId);
    expect(retry).toMatchObject({
      status: 'fallback',
      reason: 'storage_rejected',
    });
    expect(calls).toHaveLength(1);
  });

  it('settles an unclassified provider failure without exposing arbitrary provider detail', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    const sensitiveDetail = 'raw upstream detail with token sk-provider-secret';
    const providerError = new Error(sensitiveDetail);
    providerError.name = 'sensitive-provider-error-name';
    const { provider } = fakeCoverArt({ error: providerError });
    const d = generator(ownerUserId, provider);

    const result = await d.ensureGenerated(sessionId);

    expect(result).toEqual({
      status: 'fallback',
      reason: 'submission_unknown',
      coverImageId: null,
    });
    expect(JSON.stringify(result)).not.toContain(sensitiveDetail);
    expect(JSON.stringify(d.logs)).not.toContain(sensitiveDetail);
    expect(JSON.stringify(d.logs)).not.toContain(providerError.name);
    expect(await sessionCoverId(sessionId)).toBeNull();
    expect(await generatedCoverRows()).toHaveLength(0);
  });

  /** A session sitting on the built-in placeholder cover, awaiting its generated cover. */
  async function seedPlaceholderSession() {
    const session = await seedSession();
    await seedPlaceholderCover(ctx.db);
    await ctx.db
      .update(activitySessions)
      .set({ coverImageId: PLACEHOLDER_COVER_ID })
      .where(eq(activitySessions.id, session.sessionId));
    return session;
  }

  it('settles an unclassified provider failure without relying on Graphile exhaustion', async () => {
    const { ownerUserId, sessionId } = await seedPlaceholderSession();
    const { provider } = fakeCoverArt({
      error: new GeneratedImageProviderError('unavailable', 'outcome_unknown'),
    });

    const result = await generator(ownerUserId, provider).ensureGenerated(sessionId);

    expect(result).toMatchObject({ status: 'fallback', reason: 'submission_unknown' });
    expect(await sessionCoverId(sessionId)).toBe(PLACEHOLDER_COVER_ID);
  });

  it('a rejected configuration keeps the placeholder cover', async () => {
    const { ownerUserId, sessionId } = await seedPlaceholderSession();
    const { provider } = fakeCoverArt({
      error: new GeneratedImageProviderError('configuration', 'not_started'),
    });
    const result = await generator(ownerUserId, provider).ensureGenerated(sessionId);
    expect(result).toMatchObject({ status: 'fallback', reason: 'provider_rejected' });
    expect(await sessionCoverId(sessionId)).toBe(PLACEHOLDER_COVER_ID);
  });

  it('an exhausted cover limit keeps the placeholder without retagging MP3s', async () => {
    const { ownerUserId, sessionId } = await seedPlaceholderSession();
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
    await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      audioStorageKey: 'tracks/fixture/final.mp3',
    });
    await updateUsageLimits(ctx.db, { generatedCoversPerDay: 0 });

    const { provider } = fakeCoverArt();
    const d = generator(ownerUserId, provider);
    const result = await d.ensureGenerated(sessionId);
    expect(result).toMatchObject({ status: 'fallback', reason: 'not_admitted' });
    expect(await sessionCoverId(sessionId)).toBe(PLACEHOLDER_COVER_ID);
    // The cover did not change, so the final MP3's embedded art is still right.
    expect(d.embedded).toEqual([]);
  });

  it('the fallback never overwrites a session already wearing a real cover', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    const [handPickedRow] = await ctx.db
      .insert(coverImages)
      .values({
        sourceType: 'generated',
        storageProvider: 'local-fs',
        storageKey: 'covers/generated/hand-picked.webp',
      })
      .returning({ id: coverImages.id });
    const handPicked = handPickedRow!.id;
    await ctx.db
      .update(activitySessions)
      .set({ coverImageId: handPicked })
      .where(eq(activitySessions.id, sessionId));

    const { provider } = fakeCoverArt({
      error: new GeneratedImageProviderError('configuration', 'not_started'),
    });
    const result = await generator(ownerUserId, provider).ensureGenerated(sessionId);
    expect(result).toEqual({ status: 'preserved', coverImageId: handPicked });
    expect(await sessionCoverId(sessionId)).toBe(handPicked);
  });

  it('a terminal outcome keeps the placeholder cover', async () => {
    const { ownerUserId, sessionId } = await seedPlaceholderSession();
    await generator(ownerUserId, null).ensureGenerated(sessionId);
    expect(await sessionCoverId(sessionId)).toBe(PLACEHOLDER_COVER_ID);

    await generator(ownerUserId, null).ensureGenerated(sessionId);
    expect(await sessionCoverId(sessionId)).toBe(PLACEHOLDER_COVER_ID);
  });

  it('a retry after a post-payment storage failure keeps the placeholder without re-buying', async () => {
    const { ownerUserId, sessionId } = await seedPlaceholderSession();
    const { provider, calls } = fakeCoverArt();
    const write = vi.spyOn(store.provider, 'write').mockRejectedValueOnce(new Error('disk full'));
    const result = await generator(ownerUserId, provider).ensureGenerated(sessionId);
    write.mockRestore();
    expect(result).toMatchObject({
      status: 'fallback',
      reason: 'storage_rejected',
    });
    expect(await sessionCoverId(sessionId)).toBe(PLACEHOLDER_COVER_ID);

    const retry = await generator(ownerUserId, provider).ensureGenerated(sessionId);
    expect(retry).toMatchObject({ status: 'fallback', reason: 'storage_rejected' });
    expect(calls).toHaveLength(1);
    expect(await sessionCoverId(sessionId)).toBe(PLACEHOLDER_COVER_ID);
  });

  it('a rejected configuration completes without retrying (no cover lands)', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    const { provider } = fakeCoverArt({
      error: new GeneratedImageProviderError('configuration', 'not_started'),
    });
    const result = await generator(ownerUserId, provider).ensureGenerated(sessionId);
    expect(result).toMatchObject({ status: 'fallback', reason: 'provider_rejected' });
    expect(await sessionCoverId(sessionId)).toBeNull();
  });

  it('stores normalized Poster Art without a local title treatment', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: SNAPSHOT,
      coverStyle: 'poster_art',
      title: 'Rainy Window Frequencies for Late Night Focus',
    });
    const { provider, calls } = fakeCoverArt();
    const normalized = new Uint8Array([10, 20, 30]);
    const result = await generator(ownerUserId, provider, {
      normalizeCover: async () => normalized,
    }).ensureGenerated(sessionId);

    expect(result).toMatchObject({ status: 'ready', generatedNow: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.positivePrompt).not.toMatch(/title-safe|applied locally/i);
    expect(calls[0]!.positivePrompt).toMatch(/render no (?:words|lettering)/i);
    expect(calls[0]!.positivePrompt).toContain(
      'Session Name: "Rainy Window Frequencies for Late Night Focus"',
    );
    expect(calls[0]!.exclusions.join(' ')).toMatch(/readable text|lettering/i);
    const [ledger] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(ledger).toMatchObject({
      state: 'ready',
    });
    expect(ledger!.plan).toMatchObject({
      sessionName: 'Rainy Window Frequencies for Late Night Focus',
      resolvedStyle: 'poster_art',
    });
    expect(await readAllBytes(await store.provider.readStream(ledger!.storageKey))).toEqual(
      normalized,
    );
  });

  it('without an LLM, the raw hint is sanitized deterministically, persisted, and compiled', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: SNAPSHOT,
      coverStyle: 'custom',
      title: 'Custom Ink Session',
      coverStyleHint: '  bold ink lines,\n  explosive colors  ',
    });
    const { provider, calls } = fakeCoverArt();
    const result = await generator(ownerUserId, provider).ensureGenerated(sessionId);
    expect(result).toMatchObject({ status: 'ready', generatedNow: true });
    expect(calls[0]!.positivePrompt).toContain('bold ink lines, explosive colors');
    expect(calls[0]!.positivePrompt).toMatch(/named brands|franchises/i);

    const [ledger] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(ledger!.plan.customDefinition).toBe('bold ink lines, explosive colors');

    // The normalization is persisted on the session (the one-time marker).
    const [row] = await ctx.db
      .select({ normalized: activitySessions.coverStyleHintNormalized })
      .from(activitySessions)
      .where(eq(activitySessions.id, sessionId));
    expect(row!.normalized).toBe('bold ink lines, explosive colors');
  });

  it('a quality-gate failure keeps the current cover but still counts the spend (no re-buy)', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    const { provider, calls } = fakeCoverArt();
    const d = generator(ownerUserId, provider, {
      evaluateCover: async () => ({ ok: false, reason: 'blank' }),
    });
    const result = await d.ensureGenerated(sessionId);
    expect(result).toMatchObject({ status: 'fallback', reason: 'quality_rejected' });
    expect(await sessionCoverId(sessionId)).toBeNull();

    const [ledger] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(ledger).toMatchObject({ state: 'quality_rejected', possiblyPaid: true });
    expect(await generatedCoverRows()).toHaveLength(0);
    expect(await store.provider.stat(ledger!.storageKey)).toBeNull();
    const retry = await generator(ownerUserId, provider).ensureGenerated(sessionId);
    expect(retry).toMatchObject({
      status: 'fallback',
      reason: 'quality_rejected',
    });
    expect(calls).toHaveLength(1);
  });

  it('reuses the persisted plan and idempotency key for one proven-safe retry', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    const { provider, calls } = fakeCoverArt({
      idempotency: 'native',
      error: (attempt) =>
        attempt === 1
          ? new GeneratedImageProviderError('unavailable', 'retryable_with_same_key')
          : undefined,
    });

    await expect(
      generator(ownerUserId, provider).ensureGenerated(sessionId),
    ).rejects.toBeInstanceOf(SessionCoverRetryableError);
    const [retrying] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(retrying).toMatchObject({ state: 'planned', safeRetryCount: 1, maxSafeRetries: 1 });

    await expect(
      generator(ownerUserId, provider).ensureGenerated(sessionId),
    ).resolves.toMatchObject({
      status: 'ready',
      generatedNow: true,
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.idempotencyKey).toBe(calls[0]!.idempotencyKey);
    expect(calls[1]!.positivePrompt).toBe(calls[0]!.positivePrompt);
  });

  it('settles terminally on the final safe-retry attempt instead of exhausting Graphile', async () => {
    const { ownerUserId, sessionId } = await seedPlaceholderSession();
    const { provider, calls } = fakeCoverArt({
      error: new GeneratedImageProviderError('unavailable', 'not_started'),
    });

    await expect(
      generator(ownerUserId, provider).ensureGenerated(sessionId),
    ).rejects.toBeInstanceOf(SessionCoverRetryableError);
    await expect(
      generator(ownerUserId, provider).ensureGenerated(sessionId),
    ).resolves.toMatchObject({
      status: 'fallback',
      reason: 'provider_unavailable',
    });
    expect(calls).toHaveLength(2);
    expect(await sessionCoverId(sessionId)).toBe(PLACEHOLDER_COVER_ID);
    const [settled] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(settled).toMatchObject({
      state: 'provider_unavailable',
      safeRetryCount: 2,
      maxSafeRetries: 1,
      possiblyPaid: false,
    });
  });

  it.each(['storing', 'submitting'] as const)(
    'lands an aged %s operation from its deterministic final WebP key before any resubmission',
    async (recoveryState) => {
      const { ownerUserId, sessionId } = await seedSession();
      const { provider, calls } = fakeCoverArt({
        error: new GeneratedImageProviderError('unavailable', 'outcome_unknown'),
      });
      await generator(ownerUserId, provider).ensureGenerated(sessionId);
      const [ledger] = await ctx.db
        .select()
        .from(sessionCoverGenerations)
        .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
      await store.provider.write({
        key: ledger!.storageKey,
        body: IMAGE_BYTES,
        mimeType: 'image/webp',
      });
      await ctx.db
        .update(sessionCoverGenerations)
        .set({
          state: recoveryState,
          failureCategory: null,
          settledAt: null,
          updatedAt: new Date('2026-07-12T11:00:00.000Z'),
        })
        .where(eq(sessionCoverGenerations.id, ledger!.id));

      await expect(
        generator(ownerUserId, provider).ensureGenerated(sessionId),
      ).resolves.toMatchObject({
        status: 'ready',
        coverImageId: ledger!.coverImageId,
        generatedNow: false,
      });
      expect(calls).toHaveLength(1);
      expect(await sessionCoverId(sessionId)).toBe(ledger!.coverImageId);
      expect(await generatedCoverRows()).toHaveLength(1);
    },
  );

  it('leaves sound recovered bytes storing for the next pass when persisting them fails', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    const { provider, calls } = fakeCoverArt({
      error: new GeneratedImageProviderError('unavailable', 'outcome_unknown'),
    });
    await generator(ownerUserId, provider).ensureGenerated(sessionId);
    const [ledger] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    await store.provider.write({
      key: ledger!.storageKey,
      body: IMAGE_BYTES,
      mimeType: 'image/webp',
    });
    await ctx.db
      .update(sessionCoverGenerations)
      .set({
        state: 'storing',
        failureCategory: null,
        settledAt: null,
        updatedAt: new Date('2026-07-12T11:00:00.000Z'),
      })
      .where(eq(sessionCoverGenerations.id, ledger!.id));
    let failed = false;
    const flakyDb = new Proxy(ctx.db, {
      get(target, prop) {
        if (prop === 'insert') {
          return (table: unknown) => {
            if (table === coverImages && !failed) {
              failed = true;
              throw new Error('Connection terminated unexpectedly');
            }
            return target.insert(table as typeof coverImages);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(
      generator(ownerUserId, provider, { db: flakyDb }).ensureGenerated(sessionId),
    ).rejects.toBeInstanceOf(SessionCoverRetryableError);
    const [kept] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.id, ledger!.id));
    expect(kept!.state).toBe('storing');

    await expect(
      generator(ownerUserId, provider).ensureGenerated(sessionId),
    ).resolves.toMatchObject({ status: 'ready', coverImageId: ledger!.coverImageId });
    expect(calls).toHaveLength(1);
  });

  it('keeps a possibly-paid submission counted when its safe retry refuses the references', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    await ctx.db
      .insert(listenerProfiles)
      .values({ ownerUserId, coverReferenceFrequency: 'always' });
    await seedReference(ownerUserId);
    const { provider, calls } = fakeCoverArt({
      idempotency: 'native',
      error: (attempt) =>
        attempt === 1
          ? new GeneratedImageProviderError('unavailable', 'outcome_unknown')
          : undefined,
    });
    await expect(
      generator(ownerUserId, provider).ensureGenerated(sessionId),
    ).rejects.toBeInstanceOf(SessionCoverRetryableError);
    const [retrying] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(retrying).toMatchObject({ state: 'planned', possiblyPaid: true, safeRetryCount: 1 });
    await ctx.db
      .update(listenerProfiles)
      .set({ coverReferenceFrequency: 'never' })
      .where(eq(listenerProfiles.ownerUserId, ownerUserId));

    await expect(
      generator(ownerUserId, provider).ensureGenerated(sessionId),
    ).resolves.toMatchObject({ status: 'fallback', reason: 'privacy_rejected' });
    expect(calls).toHaveLength(1);
    const [settled] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(settled).toMatchObject({
      state: 'privacy_rejected',
      possiblyPaid: true,
      submittedAt: retrying!.submittedAt,
    });
  });

  it('buys no prompt-only cover when a retry after a restart cannot send the frozen photos', async () => {
    // Run two's adapter refuses before paying: a live descriptor that cannot take
    // the photo, or a discovery outage that cannot tell whether it could.
    const refusals = [
      {
        error: new GeneratedImageProviderError('references_unsupported', 'not_started'),
        reason: 'references_unsupported',
        settled: { state: 'not_admitted', failureCategory: 'references_unsupported' },
      },
      {
        error: new GeneratedImageProviderError('unavailable', 'not_started'),
        reason: 'provider_unavailable',
        settled: { state: 'provider_unavailable', failureCategory: 'provider_unavailable' },
      },
    ];
    for (const refusal of refusals) {
      const { ownerUserId, sessionId } = await seedSession();
      await ctx.db
        .insert(listenerProfiles)
        .values({ ownerUserId, coverReferenceFrequency: 'always' })
        .onConflictDoNothing();
      await seedReference(ownerUserId);
      const { provider, calls } = fakeCoverArt({
        idempotency: 'native',
        error: (attempt) =>
          attempt === 1
            ? new GeneratedImageProviderError('unavailable', 'outcome_unknown')
            : refusal.error,
      });
      await expect(
        generator(ownerUserId, provider).ensureGenerated(sessionId),
      ).rejects.toBeInstanceOf(SessionCoverRetryableError);
      const [retrying] = await ctx.db
        .select()
        .from(sessionCoverGenerations)
        .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
      expect(retrying).toMatchObject({ state: 'planned', possiblyPaid: true });

      await expect(
        generator(ownerUserId, provider).ensureGenerated(sessionId),
      ).resolves.toMatchObject({ status: 'fallback', reason: refusal.reason });
      expect(calls).toHaveLength(2);
      expect(calls[1]!.references).toHaveLength(1);
      const [settled] = await ctx.db
        .select()
        .from(sessionCoverGenerations)
        .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
      expect(settled).toMatchObject({
        ...refusal.settled,
        possiblyPaid: true,
        submissionDisposition: 'not_started',
        submittedAt: retrying!.submittedAt,
      });
      expect(settled!.settledAt).not.toBeNull();
    }
  });

  it('counts no spend when a first submission is refused before paying for its photos', async () => {
    const refusals = [
      {
        error: new GeneratedImageProviderError('references_unsupported', 'not_started'),
        settled: { state: 'not_admitted', failureCategory: 'references_unsupported' },
      },
      {
        error: new GeneratedImageProviderError('unavailable', 'not_started'),
        settled: { state: 'provider_unavailable', failureCategory: 'provider_unavailable' },
      },
    ];
    for (const refusal of refusals) {
      const { ownerUserId, sessionId } = await seedSession();
      await ctx.db
        .insert(listenerProfiles)
        .values({ ownerUserId, coverReferenceFrequency: 'always' })
        .onConflictDoNothing();
      await seedReference(ownerUserId);
      const { provider } = fakeCoverArt({ error: refusal.error });

      // An outage refusal gets its one safe retry first; the reference refusal none.
      for (let run = 0; run < 2; run += 1) {
        await generator(ownerUserId, provider)
          .ensureGenerated(sessionId)
          .catch((error: unknown) => expect(error).toBeInstanceOf(SessionCoverRetryableError));
      }
      const [settled] = await ctx.db
        .select()
        .from(sessionCoverGenerations)
        .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
      expect(settled).toMatchObject({
        ...refusal.settled,
        possiblyPaid: false,
        submittedAt: null,
      });
    }
  });

  it('buys no initial cover for a Session whose delete is pending', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    await ctx.db
      .update(activitySessions)
      .set({ status: 'stopped', deleteRequestedAt: new Date() })
      .where(eq(activitySessions.id, sessionId));
    const { provider, calls } = fakeCoverArt();

    await expect(
      generator(ownerUserId, provider).ensureGenerated(sessionId),
    ).resolves.toMatchObject({ status: 'fallback' });
    expect(calls).toHaveLength(0);
    expect(await ctx.db.select().from(sessionCoverGenerations)).toHaveLength(0);
  });

  it('settles a retrying attempt without a second call once the Session delete is pending', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    const { provider, calls } = fakeCoverArt({
      error: (attempt) =>
        attempt === 1 ? new GeneratedImageProviderError('unavailable', 'not_started') : undefined,
    });
    await expect(
      generator(ownerUserId, provider).ensureGenerated(sessionId),
    ).rejects.toBeInstanceOf(SessionCoverRetryableError);
    await ctx.db
      .update(activitySessions)
      .set({ status: 'stopped', deleteRequestedAt: new Date() })
      .where(eq(activitySessions.id, sessionId));

    await expect(
      generator(ownerUserId, provider).ensureGenerated(sessionId),
    ).resolves.toMatchObject({ status: 'fallback', reason: 'not_admitted' });
    expect(calls).toHaveLength(1);
    const [settled] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(settled).toMatchObject({ state: 'not_admitted', possiblyPaid: false });
    // Nothing live is left, so the deferred delete can finish.
    await expect(deleteSession(ctx.db, { ownerUserId, sessionId })).resolves.toMatchObject({
      ok: true,
      deferred: false,
    });
  });

  it('settles a retrying attempt without a second call once the Member is disabled', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    await ctx.db.insert(userProfiles).values({ userId: ownerUserId, role: 'member' });
    const { provider, calls } = fakeCoverArt({
      error: (attempt) =>
        attempt === 1 ? new GeneratedImageProviderError('rate_limit', 'not_started') : undefined,
    });
    await expect(
      generator(ownerUserId, provider).ensureGenerated(sessionId),
    ).rejects.toBeInstanceOf(SessionCoverRetryableError);
    await setMemberDisabled(ctx.db, { userId: ownerUserId, disabled: true });

    await expect(
      generator(ownerUserId, provider).ensureGenerated(sessionId),
    ).resolves.toMatchObject({ status: 'fallback', reason: 'not_admitted' });
    expect(calls).toHaveLength(1);
    const [settled] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
    expect(settled).toMatchObject({
      state: 'not_admitted',
      possiblyPaid: false,
      failureCategory: 'account_disabled',
    });
  });

  it('settles an aged non-idempotent submission as unknown without resubmitting', async () => {
    const { ownerUserId, sessionId } = await seedPlaceholderSession();
    const { provider, calls } = fakeCoverArt({
      error: new GeneratedImageProviderError('unavailable', 'outcome_unknown'),
    });
    await generator(ownerUserId, provider).ensureGenerated(sessionId);
    await ctx.db
      .update(sessionCoverGenerations)
      .set({
        state: 'submitting',
        possiblyPaid: true,
        settledAt: null,
        updatedAt: new Date('2026-07-12T11:00:00.000Z'),
      })
      .where(eq(sessionCoverGenerations.activitySessionId, sessionId));

    await expect(
      generator(ownerUserId, provider).ensureGenerated(sessionId),
    ).resolves.toMatchObject({
      status: 'fallback',
      reason: 'submission_unknown',
    });
    expect(calls).toHaveLength(1);
    expect(await sessionCoverId(sessionId)).toBe(PLACEHOLDER_COVER_ID);
  });

  it('a ready-operation recovery with nothing to land enqueues no retags and no new spend', async () => {
    const { ownerUserId, sessionId } = await seedSession();
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
    await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      audioStorageKey: 'tracks/recovery/final.mp3',
    });
    const { provider, calls } = fakeCoverArt();
    await generator(ownerUserId, provider).ensureGenerated(sessionId);

    // The session already wears the cover: the re-run must not re-enqueue a
    // retag for every final MP3 (this path recurs from the recovery cron).
    const recovery = generator(ownerUserId, provider);
    await expect(recovery.ensureGenerated(sessionId)).resolves.toMatchObject({
      status: 'ready',
      generatedNow: false,
    });
    expect(recovery.embedded).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  describe('music-task-driven provider (Suno cover fallback)', () => {
    const SOURCE = { musicProviderKey: 'suno' };

    async function seedReadyMusicTask(ownerUserId: string, sessionId: string): Promise<string> {
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
        providerKey: 'suno',
      });
      await createProviderJob(ctx.db, {
        generationRequestId: requestId,
        providerKey: 'suno',
        normalizedStatus: 'ready',
        providerTaskId: 'music-task-42',
      });
      return 'music-task-42';
    }

    it('waits (retryable, nothing admitted) while the session has no ready music task', async () => {
      const { ownerUserId, sessionId } = await seedSession();
      const { provider, calls } = fakeCoverArt({ musicTaskSource: SOURCE });
      // Session createdAt is DB "now"; the frozen test clock lies before it, so
      // the attempt is well inside the wait window.
      await expect(
        generator(ownerUserId, provider).ensureGenerated(sessionId),
      ).rejects.toBeInstanceOf(SessionCoverRetryableError);
      expect(calls).toHaveLength(0);
      const rows = await ctx.db
        .select()
        .from(sessionCoverGenerations)
        .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
      expect(rows).toHaveLength(0);
      expect(await sessionCoverId(sessionId)).toBeNull();
    });

    it('settles terminally when no music task is ready past the wait window', async () => {
      const { ownerUserId, sessionId } = await seedSession();
      const { provider, calls } = fakeCoverArt({ musicTaskSource: SOURCE });
      const d = generator(ownerUserId, provider, {
        // 31 minutes past the session's creation (DB now is the fixture insert).
        clock: { now: () => new Date(Date.now() + 31 * 60 * 1_000) },
      });
      const result = await d.ensureGenerated(sessionId);
      expect(result).toMatchObject({ status: 'fallback', reason: 'provider_unavailable' });
      expect(calls).toHaveLength(0);
      const [ledger] = await ctx.db
        .select()
        .from(sessionCoverGenerations)
        .where(eq(sessionCoverGenerations.activitySessionId, sessionId));
      expect(ledger).toMatchObject({
        state: 'not_admitted',
        possiblyPaid: false,
        failureCategory: 'provider_unavailable',
      });
      // No cover lands — the session keeps what it wears (nothing here).
      expect(await sessionCoverId(sessionId)).toBeNull();
    });

    it('generates once a music task is ready and passes its task id to the provider', async () => {
      const { ownerUserId, sessionId } = await seedSession();
      const taskId = await seedReadyMusicTask(ownerUserId, sessionId);
      const { provider, calls } = fakeCoverArt({
        musicTaskSource: SOURCE,
        idempotency: 'recoverable',
      });
      // Standard covers flow through the same finalizer as prompt-driven ones:
      // what lands in storage must be the finalized output, not the raw artwork.
      const finalizedBytes = new Uint8Array([...IMAGE_BYTES, 0xbb]);
      const result = await generator(ownerUserId, provider, {
        normalizeCover: async () => finalizedBytes,
      }).ensureGenerated(sessionId);
      expect(result).toMatchObject({ status: 'ready', generatedNow: true });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.musicTaskId).toBe(taskId);
      const rows = await generatedCoverRows();
      expect(rows).toHaveLength(1);
      expect(await sessionCoverId(sessionId)).toBe(rows[0]!.id);
      expect(await readAllBytes(await store.provider.readStream(rows[0]!.storageKey))).toEqual(
        finalizedBytes,
      );
    });

    it('retries with the admitted music task after an older task turns ready', async () => {
      const { ownerUserId, sessionId } = await seedSession();
      const olderRequestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
        providerKey: 'suno',
      });
      const olderJobId = await createProviderJob(ctx.db, {
        generationRequestId: olderRequestId,
        providerKey: 'suno',
        normalizedStatus: 'processing',
        providerTaskId: 'music-task-older',
        createdAt: new Date(Date.now() - 60_000),
      });
      const taskId = await seedReadyMusicTask(ownerUserId, sessionId);
      const { provider, calls } = fakeCoverArt({
        musicTaskSource: SOURCE,
        idempotency: 'recoverable',
        error: (attempt) =>
          attempt === 1
            ? new GeneratedImageProviderError('unavailable', 'outcome_unknown')
            : undefined,
      });
      await expect(
        generator(ownerUserId, provider).ensureGenerated(sessionId),
      ).rejects.toBeInstanceOf(SessionCoverRetryableError);
      await ctx.db
        .update(providerJobs)
        .set({ normalizedStatus: 'ready' })
        .where(eq(providerJobs.id, olderJobId));

      await expect(
        generator(ownerUserId, provider).ensureGenerated(sessionId),
      ).resolves.toMatchObject({ status: 'ready', generatedNow: true });
      expect(calls.map((call) => call.musicTaskId)).toEqual([taskId, taskId]);
    });

    it('generates even when required People references are unsupported by the provider', async () => {
      // The person policy refuses a STYLED attempt when references are required
      // but unsupported; a music-task-driven cover consumes no prompt and no
      // references, so the policy must never refuse it.
      const { ownerUserId, sessionId } = await seedSession();
      await ctx.db
        .insert(listenerProfiles)
        .values({ ownerUserId, coverReferenceFrequency: 'always' });
      await seedReference(ownerUserId);
      const taskId = await seedReadyMusicTask(ownerUserId, sessionId);
      const { provider, calls } = fakeCoverArt({
        musicTaskSource: SOURCE,
        supportsReferences: false,
        idempotency: 'recoverable',
      });

      const result = await generator(ownerUserId, provider).ensureGenerated(sessionId);
      expect(result).toMatchObject({ status: 'ready', generatedNow: true });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.references).toEqual([]);
      expect(calls[0]!.musicTaskId).toBe(taskId);
    });

    it('generates even when prompt planning would refuse the session name', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, {
        ownerUserId,
        styleSnapshot: SNAPSHOT,
        title: null,
      });
      const taskId = await seedReadyMusicTask(ownerUserId, sessionId);
      const { provider, calls } = fakeCoverArt({
        musicTaskSource: SOURCE,
        idempotency: 'recoverable',
      });

      const result = await generator(ownerUserId, provider).ensureGenerated(sessionId);
      expect(result).toMatchObject({ status: 'ready', generatedNow: true });
      expect(calls[0]!.musicTaskId).toBe(taskId);
    });

    it('ignores other providers’ ready tasks when resolving the source task', async () => {
      const { ownerUserId, sessionId } = await seedSession();
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
        providerKey: 'mock',
      });
      await createProviderJob(ctx.db, {
        generationRequestId: requestId,
        providerKey: 'mock',
        normalizedStatus: 'ready',
      });
      const { provider, calls } = fakeCoverArt({ musicTaskSource: SOURCE });
      await expect(
        generator(ownerUserId, provider).ensureGenerated(sessionId),
      ).rejects.toBeInstanceOf(SessionCoverRetryableError);
      expect(calls).toHaveLength(0);
    });
  });
});
