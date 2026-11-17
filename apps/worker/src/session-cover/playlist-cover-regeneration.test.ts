import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  coverImages,
  createPerson,
  createPlaylist,
  deletePersonReferencePhoto,
  deletePlaylist,
  ensureOwnerPerson,
  insertPersonReferencePhoto,
  playlists,
  playlistTracks,
  reservePlaylistCoverRegeneration,
  sessionCoverGenerations,
  updateCoverReferenceFrequency,
  updatePerson,
  updateUsageLimits,
  type PersonRow,
} from '@liedmotif/db';
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
  createPlaylistCoverGenerator,
  type PlaylistCoverGenerator,
  type PlaylistCoverGeneratorDeps,
} from './playlist-cover-regeneration';
import { SessionCoverRetryableError } from './session-cover-attempt';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const FIXTURE_TABLES = [
  ...GENERATION_FIXTURE_TABLES,
  'playlist_tracks',
  'playlists',
  'cover_images',
  'listener_profiles',
  'person_reference_photos',
  'people',
  'app_settings',
] as const;

const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);
const PHOTO_BYTES = new Uint8Array([1, 2, 3, 4]);

function fakeCoverArt(
  behavior: {
    error?: Error | ((attempt: number) => Error | undefined);
    supportsReferences?: boolean;
    maxReferences?: number;
    maxReferenceBytes?: number;
    musicTaskSource?: { musicProviderKey: string };
  } = {},
) {
  const calls: GeneratedImageRequest[] = [];
  const capabilities: GeneratedImageCapabilities = {
    provider: { providerType: 'image', providerKey: 'fake-images', model: 'test/cover-model' },
    maxPromptCharacters: 8_000,
    exclusions: 'inline',
    nativeSeed: true,
    idempotency: 'absent',
    references: behavior.supportsReferences
      ? {
          roles: ['subject'],
          maxCount: behavior.maxReferences ?? 3,
          multiSubjectIdentity: false,
          mediaTypes: ['image/jpeg', 'image/png', 'image/webp'],
          maxBytesPerReference: behavior.maxReferenceBytes ?? 2_000_000,
          maxTotalBytes: 4_000_000,
        }
      : null,
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

describeIfDb('PlaylistCoverGenerator regeneration', () => {
  let ctx: TestDb;
  let store: MockStorage;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-playlist-cover-regeneration-test');
    store = createMockStorageProvider();
  }, 60_000);

  afterAll(async () => {
    await ctx?.pool.end();
    await store?.cleanup();
  });

  beforeEach(async () => {
    await truncateTables(ctx.pool, FIXTURE_TABLES);
  });

  async function seedPlaylistWithMembers(name = 'Focus Nights') {
    const ownerUserId = await createUser(ctx.db);
    const playlist = await createPlaylist(ctx.db, { ownerUserId, name });
    const activitySessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
    const memberGenres = [['lofi'], ['lofi'], ['jazz']];
    for (const [index, genreTags] of memberGenres.entries()) {
      const requestId = await createGenerationRequest(ctx.db, { ownerUserId, activitySessionId });
      const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
      const trackId = await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
        genreTags,
      });
      await ctx.db
        .insert(playlistTracks)
        .values({ playlistId: playlist.id, trackId, position: index });
    }
    return { ownerUserId, playlistId: playlist.id };
  }

  async function reserveAttempt(
    ownerUserId: string,
    playlistId: string,
    opts: {
      id?: string;
      guidance?: string;
      effectiveGuidance?: string;
      coverStyle?: string;
      usePeopleReferences?: boolean;
    } = {},
  ) {
    const attemptId = opts.id ?? randomUUID();
    const coverImageId = randomUUID();
    const row = await reservePlaylistCoverRegeneration(ctx.db, {
      id: attemptId,
      ownerUserId,
      playlistId,
      coverImageId,
      storageKey: storageKeys.generatedPlaylistCover(ownerUserId, playlistId, coverImageId, 'webp'),
      coverStyle: opts.coverStyle ?? 'minimal',
      ...(opts.guidance === undefined ? {} : { userGuidance: opts.guidance }),
      ...(opts.effectiveGuidance === undefined
        ? {}
        : { effectiveGuidance: opts.effectiveGuidance }),
      ...(opts.usePeopleReferences === undefined
        ? {}
        : { usePeopleReferences: opts.usePeopleReferences }),
    });
    expect(row).not.toBeNull();
    return row!;
  }

  function generator(
    ownerUserId: string,
    imageProvider: GeneratedImageProvider | null,
    overrides: Partial<PlaylistCoverGeneratorDeps> = {},
  ): PlaylistCoverGenerator {
    return createPlaylistCoverGenerator({
      db: ctx.db,
      ownerUserId,
      imageProvider,
      storage: store.provider,
      evaluateCover: async () => ({ ok: true, width: 1024, height: 1024 }),
      normalizeCover: async (bytes) => bytes,
      measureCover: async () => ({ width: 1024, height: 1024 }),
      logger: { info: () => undefined, warn: () => undefined },
      clock: { now: () => new Date('2026-07-23T12:00:00.000Z') },
      ...overrides,
    });
  }

  async function playlistCoverId(playlistId: string): Promise<string | null> {
    const [row] = await ctx.db
      .select({ coverImageId: playlists.coverImageId })
      .from(playlists)
      .where(eq(playlists.id, playlistId));
    return row!.coverImageId;
  }

  async function ledgerRow(id: string) {
    const [row] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.id, id));
    return row ?? null;
  }

  it('plans from the playlist name and member genres and lands the cover in history only', async () => {
    const { ownerUserId, playlistId } = await seedPlaylistWithMembers();
    const attempt = await reserveAttempt(ownerUserId, playlistId);

    const { provider, calls } = fakeCoverArt();
    const d = generator(ownerUserId, provider);
    const result = await d.processRegeneration(playlistId, attempt.id);

    expect(result).toMatchObject({ status: 'ready', generatedNow: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ purpose: 'session-cover', count: 1, references: [] });
    // The plan is name + member-genre driven: the playlist name is the anchored
    // subject and the dominant member genre rides the supporting context.
    expect(calls[0]!.positivePrompt).toContain('"Focus Nights"');
    expect(calls[0]!.positivePrompt).toContain('lofi');
    // Confirm-first: the playlist keeps its mosaic (null pointer) until the
    // user selects the new cover — the attempt only joins the history.
    expect(await playlistCoverId(playlistId)).toBeNull();
    const settled = await ledgerRow(attempt.id);
    expect(settled).toMatchObject({
      state: 'ready',
      trigger: 'user_regenerate',
      playlistId,
      activitySessionId: null,
    });
    expect(settled!.plan.resolvedStyle).toBe('minimal');
    const [cover] = await ctx.db
      .select()
      .from(coverImages)
      .where(eq(coverImages.id, attempt.coverImageId));
    expect(cover?.sourceType).toBe('generated');
    expect(cover?.provenance).toMatchObject({ playlistId, branded: false });
    // Playlist covers ship unbadged: the stored bytes are the normalized
    // provider image with no brand overlay composited over it.
    const stored = await readAllBytes(await store.provider.readStream(attempt.storageKey));
    expect(stored).toEqual(IMAGE_BYTES);
  });

  it('freezes the modal guidance into the composed provider prompt', async () => {
    const { ownerUserId, playlistId } = await seedPlaylistWithMembers();
    const attempt = await reserveAttempt(ownerUserId, playlistId, {
      guidance: 'warm dusk light over a paper skyline',
    });

    const { provider, calls } = fakeCoverArt();
    const d = generator(ownerUserId, provider);
    const result = await d.processRegeneration(playlistId, attempt.id);

    expect(result).toMatchObject({ status: 'ready' });
    expect(calls[0]!.positivePrompt).toContain('"warm dusk light over a paper skyline"');
    const settled = await ledgerRow(attempt.id);
    expect(settled?.plan.userGuidance).toBe('warm dusk light over a paper skyline');
  });

  it('keeps named references in the art direction only when a Writing AI is configured', async () => {
    const guidance = 'a harbor at dusk, Picasso-inspired';
    const prompts: Record<string, string> = {};
    for (const textLlmConfigured of [true, false]) {
      const { ownerUserId, playlistId } = await seedPlaylistWithMembers();
      const attempt = await reserveAttempt(ownerUserId, playlistId, { guidance });
      const { provider, calls } = fakeCoverArt();
      await generator(ownerUserId, provider, { textLlmConfigured }).processRegeneration(
        playlistId,
        attempt.id,
      );
      prompts[String(textLlmConfigured)] = calls[0]!.positivePrompt;
    }

    expect(prompts.true).toContain(JSON.stringify(guidance));
    expect(prompts.false).toContain('harbor at dusk');
    expect(prompts.false).not.toMatch(/picasso/i);
  });

  it('keeps the current cover and settles terminally when the provider rejects', async () => {
    const { ownerUserId, playlistId } = await seedPlaylistWithMembers();
    const attempt = await reserveAttempt(ownerUserId, playlistId);

    const { provider } = fakeCoverArt({
      error: new GeneratedImageProviderError('rejection', 'not_started'),
    });
    const d = generator(ownerUserId, provider);
    const result = await d.processRegeneration(playlistId, attempt.id);

    expect(result).toMatchObject({ status: 'failed', reason: 'provider_rejected' });
    expect(await playlistCoverId(playlistId)).toBeNull();
    const settled = await ledgerRow(attempt.id);
    expect(settled?.state).toBe('provider_rejected');
    expect(settled?.settledAt).not.toBeNull();
  });

  it('refuses admission at the shared cover limit without spending', async () => {
    const { ownerUserId, playlistId } = await seedPlaylistWithMembers();
    await updateUsageLimits(ctx.db, { generatedCoversPerDay: 0 });
    const attempt = await reserveAttempt(ownerUserId, playlistId);

    const { provider, calls } = fakeCoverArt();
    const d = generator(ownerUserId, provider);
    const result = await d.processRegeneration(playlistId, attempt.id);

    expect(result).toMatchObject({ status: 'failed', reason: 'not_admitted' });
    expect(calls).toHaveLength(0);
    const settled = await ledgerRow(attempt.id);
    expect(settled?.state).toBe('not_admitted');
    expect(settled?.possiblyPaid).toBe(false);
  });

  it('settles a reserved attempt terminally when no image provider is configured', async () => {
    const { ownerUserId, playlistId } = await seedPlaylistWithMembers();
    const attempt = await reserveAttempt(ownerUserId, playlistId);

    const d = generator(ownerUserId, null);
    const result = await d.processRegeneration(playlistId, attempt.id);

    expect(result).toMatchObject({ status: 'failed', reason: 'provider_unconfigured' });
    const settled = await ledgerRow(attempt.id);
    expect(settled?.state).toBe('not_admitted');
  });

  it('settles a retried planned attempt when the provider is gone on re-entry', async () => {
    const { ownerUserId, playlistId } = await seedPlaylistWithMembers();
    const attempt = await reserveAttempt(ownerUserId, playlistId);
    const { provider } = fakeCoverArt({
      error: new GeneratedImageProviderError('rate_limit', 'not_started'),
    });
    await expect(
      generator(ownerUserId, provider).processRegeneration(playlistId, attempt.id),
    ).rejects.toBeInstanceOf(SessionCoverRetryableError);
    expect((await ledgerRow(attempt.id))?.state).toBe('planned');

    const result = await generator(ownerUserId, null).processRegeneration(playlistId, attempt.id);

    expect(result).toMatchObject({ status: 'failed', reason: 'provider_unconfigured' });
    // Settled, so the Playlist's next regeneration can reserve again.
    expect((await ledgerRow(attempt.id))?.state).toBe('not_admitted');
  });

  it('replays a settled attempt without a second provider call or pointer write', async () => {
    const { ownerUserId, playlistId } = await seedPlaylistWithMembers();
    const attempt = await reserveAttempt(ownerUserId, playlistId);
    const { provider, calls } = fakeCoverArt();
    const d = generator(ownerUserId, provider);
    await d.processRegeneration(playlistId, attempt.id);

    const replay = await d.processRegeneration(playlistId, attempt.id);
    expect(replay).toMatchObject({ status: 'ready', generatedNow: false });
    expect(calls).toHaveLength(1);
    expect(await playlistCoverId(playlistId)).toBeNull();
  });

  describe('while the paid call is in flight', () => {
    function gatedCoverArt() {
      const fake = fakeCoverArt();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const inFlight = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const provider: GeneratedImageProvider = {
        ...fake.provider,
        async generate(input) {
          entered();
          await gate;
          return fake.provider.generate(input);
        },
      };
      return { provider, calls: fake.calls, inFlight, release: () => release() };
    }

    it('leaves the attempt to the run paying for it when a second run arrives', async () => {
      const { ownerUserId, playlistId } = await seedPlaylistWithMembers();
      const attempt = await reserveAttempt(ownerUserId, playlistId);
      const { provider, calls, inFlight, release } = gatedCoverArt();

      const first = generator(ownerUserId, provider).processRegeneration(playlistId, attempt.id);
      await inFlight;
      const second = await generator(ownerUserId, provider).processRegeneration(
        playlistId,
        attempt.id,
      );
      release();

      expect(second).toEqual({ status: 'pending' });
      await expect(first).resolves.toMatchObject({ status: 'ready', generatedNow: true });
      expect(calls).toHaveLength(1);
      expect((await ledgerRow(attempt.id))?.state).toBe('ready');
    });

    it('writes no cover bytes when the Playlist is deleted before the provider returns', async () => {
      const { ownerUserId, playlistId } = await seedPlaylistWithMembers();
      const attempt = await reserveAttempt(ownerUserId, playlistId);
      const { provider, inFlight, release } = gatedCoverArt();

      const first = generator(ownerUserId, provider).processRegeneration(playlistId, attempt.id);
      await inFlight;
      await deletePlaylist(ctx.db, { ownerUserId, playlistId });
      release();

      await expect(first).resolves.toEqual({ status: 'pending' });
      expect(await store.provider.stat(attempt.storageKey)).toBeNull();
      expect(
        await ctx.db.select().from(coverImages).where(eq(coverImages.id, attempt.coverImageId)),
      ).toHaveLength(0);
    });
  });

  it('never lets a music-task-driven provider serve a playlist attempt', async () => {
    const { ownerUserId, playlistId } = await seedPlaylistWithMembers();
    const attempt = await reserveAttempt(ownerUserId, playlistId);
    const { provider, calls } = fakeCoverArt({ musicTaskSource: { musicProviderKey: 'suno' } });

    const result = await generator(ownerUserId, provider).processRegeneration(
      playlistId,
      attempt.id,
    );

    expect(result).toMatchObject({ status: 'failed', reason: 'provider_unconfigured' });
    expect(calls).toHaveLength(0);
    expect((await ledgerRow(attempt.id))?.state).toBe('not_admitted');
  });

  it('reports a foreign or unknown playlist as missing', async () => {
    const { ownerUserId, playlistId } = await seedPlaylistWithMembers();
    const attempt = await reserveAttempt(ownerUserId, playlistId);
    const { provider, calls } = fakeCoverArt();

    const stranger = generator(await createUser(ctx.db), provider);
    await expect(stranger.processRegeneration(playlistId, attempt.id)).resolves.toEqual({
      status: 'missing',
    });
    const owner = generator(ownerUserId, provider);
    await expect(owner.processRegeneration(randomUUID(), attempt.id)).resolves.toEqual({
      status: 'missing',
    });
    expect(calls).toHaveLength(0);
  });

  // The per-attempt "use People reference photos" toggle:
  // an attempt carries Person references only when the owner asked for them, and
  // then it either delivers them or refuses before any paid call.
  describe('People reference photos', () => {
    async function seedPhoto(ownerUserId: string, personId: string): Promise<string> {
      const id = randomUUID();
      const storageKey = storageKeys.personReferencePhoto(ownerUserId, personId, id, 'webp');
      await store.provider.write({ key: storageKey, body: PHOTO_BYTES, mimeType: 'image/webp' });
      const result = await insertPersonReferencePhoto(ctx.db, {
        id,
        ownerUserId,
        personId,
        storageProvider: 'local-fs',
        storageKey,
        mediaType: 'image/webp',
        byteSize: PHOTO_BYTES.byteLength,
      });
      expect(result.inserted).toBe(true);
      return id;
    }

    async function seedOwnerPerson(ownerUserId: string, name = 'John'): Promise<PersonRow> {
      const owner = await ensureOwnerPerson(ctx.db, ownerUserId);
      const renamed = await updatePerson(ctx.db, {
        ownerUserId,
        personId: owner.id,
        name,
        about: 'PRIVATE_OWNER_CONTEXT',
      });
      expect(renamed).not.toBeNull();
      return renamed!;
    }

    /** One playlist, one owner Person with one photo — the common starting point. */
    async function seedOwnerWithPhoto(playlistName?: string) {
      const seeded = await seedPlaylistWithMembers(playlistName);
      const person = await seedOwnerPerson(seeded.ownerUserId);
      const photoId = await seedPhoto(seeded.ownerUserId, person.id);
      return { ...seeded, person, photoId };
    }

    it('sends no references and reads no photo bytes while the toggle is off', async () => {
      const { ownerUserId, playlistId } = await seedOwnerWithPhoto();
      const attempt = await reserveAttempt(ownerUserId, playlistId);
      const readSpy = vi.spyOn(store.provider, 'readStream');
      const { provider, calls } = fakeCoverArt({ supportsReferences: true });

      const result = await generator(ownerUserId, provider).processRegeneration(
        playlistId,
        attempt.id,
      );

      expect(result).toMatchObject({ status: 'ready' });
      expect(calls[0]!.references).toEqual([]);
      expect(calls[0]!.positivePrompt).not.toContain('Reference treatment:');
      expect(readSpy).not.toHaveBeenCalled();
      const settled = await ledgerRow(attempt.id);
      expect(settled?.selectedReferences).toEqual([]);
      expect(settled?.plan.referenceTreatment).toBeNull();
      readSpy.mockRestore();
    });

    it('includes the owner Person deterministically when no configured name matches', async () => {
      const { ownerUserId, playlistId, person, photoId } = await seedOwnerWithPhoto();
      // `seldom` would normally roll the owner fallback; the explicit toggle wins.
      await updateCoverReferenceFrequency(ctx.db, ownerUserId, 'seldom');
      const attempt = await reserveAttempt(ownerUserId, playlistId, { usePeopleReferences: true });
      const { provider, calls } = fakeCoverArt({ supportsReferences: true });

      const result = await generator(ownerUserId, provider).processRegeneration(
        playlistId,
        attempt.id,
      );

      expect(result).toMatchObject({ status: 'ready', generatedNow: true });
      expect(calls[0]!.references).toEqual([
        expect.objectContaining({ id: photoId, role: 'subject', bytes: PHOTO_BYTES }),
      ]);
      expect(calls[0]!.positivePrompt).toContain('Reference treatment:');
      const settled = await ledgerRow(attempt.id);
      expect(settled?.selectedReferences).toEqual([
        { id: photoId, personId: person.id, role: 'subject' },
      ]);
      expect(settled?.plan.selectedPersonIds).toEqual([person.id]);
      expect(settled?.plan.referenceTreatment).toEqual(expect.any(String));
      expect(settled?.plan.usePeopleReferences).toBe(true);
      const [cover] = await ctx.db
        .select()
        .from(coverImages)
        .where(eq(coverImages.id, attempt.coverImageId));
      expect(cover?.provenance).toMatchObject({ referenceIds: [photoId] });
    });

    it('selects a configured Person named in the Playlist name', async () => {
      const { ownerUserId, playlistId } = await seedOwnerWithPhoto('Julia’s Running Mix');
      const julia = await createPerson(ctx.db, { ownerUserId, name: 'Julia' });
      const juliaPhoto = await seedPhoto(ownerUserId, julia.id);
      const attempt = await reserveAttempt(ownerUserId, playlistId, { usePeopleReferences: true });
      const { provider, calls } = fakeCoverArt({ supportsReferences: true });

      await generator(ownerUserId, provider).processRegeneration(playlistId, attempt.id);

      expect(calls[0]!.references.map((reference) => reference.id)).toEqual([juliaPhoto]);
    });

    it('matches over the raw art direction, never the enhanced guidance', async () => {
      const { ownerUserId, playlistId, photoId } = await seedOwnerWithPhoto();
      const julia = await createPerson(ctx.db, { ownerUserId, name: 'Julia' });
      const juliaPhoto = await seedPhoto(ownerUserId, julia.id);
      const named = await reserveAttempt(ownerUserId, playlistId, {
        usePeopleReferences: true,
        guidance: 'a portrait of Julia at the beach',
        effectiveGuidance: 'a warm cinematic portrait at the beach',
      });
      const { provider, calls } = fakeCoverArt({ supportsReferences: true });
      const instance = generator(ownerUserId, provider);

      await instance.processRegeneration(playlistId, named.id);
      // The enhancement dropped the name, but the raw text is what matched.
      expect(calls[0]!.references.map((reference) => reference.id)).toEqual([juliaPhoto]);

      const enhancedOnly = await reserveAttempt(ownerUserId, playlistId, {
        usePeopleReferences: true,
        guidance: 'a portrait at the beach',
        effectiveGuidance: 'a warm portrait of Julia at the beach',
      });
      await instance.processRegeneration(playlistId, enhancedOnly.id);
      // Enhancement cannot ADD a Person either: the owner fallback still applies.
      expect(calls[1]!.references.map((reference) => reference.id)).toEqual([photoId]);
    });

    it('refuses a toggle-on attempt as privacy-blocked when the frequency is never', async () => {
      const { ownerUserId, playlistId } = await seedOwnerWithPhoto();
      await updateCoverReferenceFrequency(ctx.db, ownerUserId, 'never');
      const attempt = await reserveAttempt(ownerUserId, playlistId, { usePeopleReferences: true });
      const readSpy = vi.spyOn(store.provider, 'readStream');
      const { provider, calls } = fakeCoverArt({ supportsReferences: true });

      const result = await generator(ownerUserId, provider).processRegeneration(
        playlistId,
        attempt.id,
      );

      expect(result).toMatchObject({ status: 'failed', reason: 'privacy_rejected' });
      expect(calls).toHaveLength(0);
      expect(readSpy).not.toHaveBeenCalled();
      expect(await ledgerRow(attempt.id)).toMatchObject({
        state: 'privacy_rejected',
        possiblyPaid: false,
        failureCategory: 'privacy_rejected',
      });
      readSpy.mockRestore();
    });

    it.each([
      ['the provider accepts no references', { supportsReferences: false }],
      [
        'the photos exceed the endpoint byte limit',
        { supportsReferences: true, maxReferenceBytes: 1 },
      ],
    ])('refuses without spending when %s', async (_case, behavior) => {
      const { ownerUserId, playlistId } = await seedOwnerWithPhoto();
      const attempt = await reserveAttempt(ownerUserId, playlistId, { usePeopleReferences: true });
      const readSpy = vi.spyOn(store.provider, 'readStream');
      const { provider, calls } = fakeCoverArt(behavior);

      const result = await generator(ownerUserId, provider).processRegeneration(
        playlistId,
        attempt.id,
      );

      expect(result).toMatchObject({ status: 'failed', reason: 'references_unsupported' });
      expect(calls).toHaveLength(0);
      expect(readSpy).not.toHaveBeenCalled();
      expect(await ledgerRow(attempt.id)).toMatchObject({
        state: 'not_admitted',
        possiblyPaid: false,
        failureCategory: 'references_unsupported',
      });
      readSpy.mockRestore();
    });

    it('refuses without spending when the owner has no Person with a photo', async () => {
      const { ownerUserId, playlistId } = await seedPlaylistWithMembers();
      const attempt = await reserveAttempt(ownerUserId, playlistId, { usePeopleReferences: true });
      const { provider, calls } = fakeCoverArt({ supportsReferences: true });

      const result = await generator(ownerUserId, provider).processRegeneration(
        playlistId,
        attempt.id,
      );

      expect(result).toMatchObject({ status: 'failed', reason: 'references_unsupported' });
      expect(calls).toHaveLength(0);
    });

    /** Drive an attempt to a `planned` retry, so the caller can change the world
     *  between the frozen plan and the submission that reads the photos. */
    async function planWithoutSubmitting(
      ownerUserId: string,
      playlistId: string,
      attemptId: string,
      behavior: Parameters<typeof fakeCoverArt>[0] = {},
    ) {
      const fake = fakeCoverArt({
        supportsReferences: true,
        ...behavior,
        error: (attempt) =>
          attempt === 1 ? new GeneratedImageProviderError('unavailable', 'not_started') : undefined,
      });
      const instance = generator(ownerUserId, fake.provider);
      await expect(instance.processRegeneration(playlistId, attemptId)).rejects.toBeInstanceOf(
        SessionCoverRetryableError,
      );
      return { ...fake, instance };
    }

    it('settles privacy_rejected when the frequency flips to never before submission', async () => {
      const { ownerUserId, playlistId } = await seedOwnerWithPhoto();
      const attempt = await reserveAttempt(ownerUserId, playlistId, { usePeopleReferences: true });
      const { calls, instance } = await planWithoutSubmitting(ownerUserId, playlistId, attempt.id);

      await updateCoverReferenceFrequency(ctx.db, ownerUserId, 'never');
      const result = await instance.processRegeneration(playlistId, attempt.id);

      expect(result).toMatchObject({ status: 'failed', reason: 'privacy_rejected' });
      expect(calls).toHaveLength(1);
      expect(await ledgerRow(attempt.id)).toMatchObject({
        state: 'privacy_rejected',
        failureCategory: 'privacy_rejected',
      });
    });

    it('settles privacy_rejected when a selected photo is deleted before submission', async () => {
      const { ownerUserId, playlistId, person, photoId } = await seedOwnerWithPhoto();
      const attempt = await reserveAttempt(ownerUserId, playlistId, { usePeopleReferences: true });
      const { calls, instance } = await planWithoutSubmitting(ownerUserId, playlistId, attempt.id);

      await deletePersonReferencePhoto(ctx.db, {
        ownerUserId,
        personId: person.id,
        photoId,
      });
      const result = await instance.processRegeneration(playlistId, attempt.id);

      expect(result).toMatchObject({ status: 'failed', reason: 'privacy_rejected' });
      expect(calls).toHaveLength(1);
      expect((await ledgerRow(attempt.id))?.state).toBe('privacy_rejected');
    });

    it('reuses the frozen photo selection when the attempt is retried', async () => {
      const { ownerUserId, playlistId, person } = await seedOwnerWithPhoto();
      await seedPhoto(ownerUserId, person.id);
      await seedPhoto(ownerUserId, person.id);
      const attempt = await reserveAttempt(ownerUserId, playlistId, { usePeopleReferences: true });
      const { calls, instance } = await planWithoutSubmitting(ownerUserId, playlistId, attempt.id, {
        maxReferences: 1,
      });

      await expect(instance.processRegeneration(playlistId, attempt.id)).resolves.toMatchObject({
        status: 'ready',
      });

      expect(calls).toHaveLength(2);
      expect(calls[0]!.references.map((reference) => reference.id)).toEqual(
        calls[1]!.references.map((reference) => reference.id),
      );
      expect(calls[1]!.references).toHaveLength(1);
    });

    it('admits one of the owner’s photos on every attempt for the same Playlist', async () => {
      const { ownerUserId, playlistId, person, photoId } = await seedOwnerWithPhoto();
      await updateUsageLimits(ctx.db, { generatedCoversPerDay: 50, generatedCoversPerMonth: 200 });
      const photoIds = [
        photoId,
        await seedPhoto(ownerUserId, person.id),
        await seedPhoto(ownerUserId, person.id),
      ];
      const { provider, calls } = fakeCoverArt({ supportsReferences: true, maxReferences: 1 });
      const instance = generator(ownerUserId, provider);

      for (const suffix of ['1', '2', '3', '4']) {
        const attempt = await reserveAttempt(ownerUserId, playlistId, {
          id: `2b1d0000-0000-4000-8000-00000000000${suffix}`,
          usePeopleReferences: true,
        });
        await instance.processRegeneration(playlistId, attempt.id);
      }

      // Each attempt admits its own single reference from the owner's photos.
      // WHICH photo wins is keyed on the attempt id, a ranking proven over fixed
      // ids beside `selectPersonCoverReferences`; the person and photo ids here
      // are minted per run, so admission is the only stable fact to assert.
      expect(calls.map((call) => call.references.length)).toEqual([1, 1, 1, 1]);
      expect(calls.every((call) => photoIds.includes(call.references[0]!.id))).toBe(true);
    });

    it('replaces the art direction’s real names with subject ordinals', async () => {
      const { ownerUserId, playlistId } = await seedOwnerWithPhoto();
      const julia = await createPerson(ctx.db, { ownerUserId, name: 'Julia' });
      await seedPhoto(ownerUserId, julia.id);
      const attempt = await reserveAttempt(ownerUserId, playlistId, {
        usePeopleReferences: true,
        guidance: 'John and Julia dancing at dusk',
      });
      const { provider, calls } = fakeCoverArt({ supportsReferences: true });

      await generator(ownerUserId, provider).processRegeneration(playlistId, attempt.id);

      expect(calls[0]!.references).toHaveLength(2);
      const artDirection = calls[0]!.positivePrompt.match(/^User art direction: (.+)$/m)?.[1] ?? '';
      expect(artDirection).toContain('subject one');
      expect(artDirection).toContain('subject two');
      expect(artDirection.toLowerCase()).not.toMatch(/john|julia/);
    });

    it('carries only ordinal subject associations for a multi-Person scene', async () => {
      const { ownerUserId, playlistId, person } = await seedOwnerWithPhoto('John and Julia');
      const julia = await createPerson(ctx.db, {
        ownerUserId,
        name: 'Julia',
        about: 'PRIVATE_JULIA_CONTEXT',
      });
      const juliaPhoto = await seedPhoto(ownerUserId, julia.id);
      const attempt = await reserveAttempt(ownerUserId, playlistId, { usePeopleReferences: true });
      const { provider, calls } = fakeCoverArt({ supportsReferences: true });

      await generator(ownerUserId, provider).processRegeneration(playlistId, attempt.id);

      expect(calls[0]!.references).toHaveLength(2);
      expect(calls[0]!.positivePrompt).toMatch(/reference image one.*reference image two/i);
      expect(calls[0]!.positivePrompt).not.toMatch(/PRIVATE_/);
      const settled = await ledgerRow(attempt.id);
      expect(settled?.plan.selectedPersonIds).toEqual([person.id, julia.id]);
      expect(settled?.selectedReferences.map((reference) => reference.id)).toContain(juliaPhoto);
    });
  });
});
