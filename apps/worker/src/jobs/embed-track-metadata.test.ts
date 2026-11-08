import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activitySessions,
  coverImages,
  generationRequests,
  trackAudioAssets,
  tracks,
  listenerProfiles,
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
import { LIEDMOTIF_TAG_MARKER, readId3Tags, stripId3v2 } from '@liedmotif/shared';
import { createMockStorageProvider, readStoredObject, type MockStorage } from '@liedmotif/storage';
import { AlbumArtCache, type RenderAlbumArt } from '@liedmotif/media';
import { runEmbedTrackMetadata, type EmbedTrackMetadataDeps } from './embed-track-metadata';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const FIXTURE_TABLES = [...GENERATION_FIXTURE_TABLES, 'cover_images', 'listener_profiles'] as const;

/** A fake MP3 body (frame sync + junk) so we can assert audio frames survive. */
const AUDIO = new Uint8Array([0xff, 0xfb, ...Array.from({ length: 48 }, (_, i) => i)]);
const JPEG_ART = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 5, 6]);

/** Stubbed rendition: records the source media type and the branded flag it
 *  was handed, always yields a JPEG. */
function fakeRenderAlbumArt(): {
  render: RenderAlbumArt;
  sourceTypes: (string | null)[];
  brandedFlags: boolean[];
} {
  const sourceTypes: (string | null)[] = [];
  const brandedFlags: boolean[] = [];
  const render: RenderAlbumArt = async (_bytes, mediaType, branded) => {
    sourceTypes.push(mediaType);
    brandedFlags.push(branded);
    return { mediaType: 'image/jpeg', bytes: JPEG_ART };
  };
  return { render, sourceTypes, brandedFlags };
}

describeIfDb('embed-track-metadata', () => {
  let ctx: TestDb;
  let store: MockStorage;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-embed-metadata-test');
    store = createMockStorageProvider();
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
    await store?.cleanup();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, FIXTURE_TABLES);
  });

  interface Seeded {
    ownerUserId: string;
    sessionId: string;
    trackId: string;
    audioKey: string;
  }

  async function seedMp3Track(
    options: {
      sessionTitle?: string;
      coverExt?: string;
      lyrics?: string;
      userPrompt?: string;
      /** The prompt history frozen on the request (what Track Data must show). */
      requestUserPrompt?: string;
      stylePrompt?: string;
      genreTags?: string[];
      bpmEstimate?: number;
      providerModel?: string;
      rightsNote?: string;
    } = {},
  ): Promise<Seeded> {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId, userPrompt: options.userPrompt });
    if (options.sessionTitle) {
      await ctx.db
        .update(activitySessions)
        .set({ title: options.sessionTitle })
        .where(eq(activitySessions.id, sessionId));
    }
    if (options.coverExt) {
      const [cover] = await ctx.db
        .insert(coverImages)
        .values({
          sourceType: 'placeholder',
          storageProvider: 'local-fs',
          storageKey: `covers/fixture.${options.coverExt}`,
        })
        .returning({ id: coverImages.id });
      await store.provider.write({
        key: `covers/fixture.${options.coverExt}`,
        body: new Uint8Array([9, 9, 9]),
      });
      await ctx.db
        .update(activitySessions)
        .set({ coverImageId: cover!.id })
        .where(eq(activitySessions.id, sessionId));
    }
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      ...(options.stylePrompt ? { stylePrompt: options.stylePrompt } : {}),
      ...(options.requestUserPrompt ? { userPrompt: options.requestUserPrompt } : {}),
    });
    const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
    const audioKey = `tracks/${ownerUserId}/fixture/track.mp3`;
    const trackId = await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      audioStorageKey: audioKey,
      ...(options.lyrics ? { vocalMode: 'vocal' as const, lyrics: options.lyrics } : {}),
      ...(options.genreTags ? { genreTags: options.genreTags } : {}),
      ...(options.bpmEstimate !== undefined ? { bpmEstimate: options.bpmEstimate } : {}),
      ...(options.providerModel ? { providerModel: options.providerModel } : {}),
      ...(options.rightsNote ? { rightsNote: options.rightsNote } : {}),
    });
    await store.provider.write({ key: audioKey, body: AUDIO, mimeType: 'audio/mpeg' });
    return { ownerUserId, sessionId, trackId, audioKey };
  }

  function deps(render: RenderAlbumArt, artworkCache?: AlbumArtCache): EmbedTrackMetadataDeps {
    return {
      db: ctx.db,
      storage: store.provider,
      albumArt: {
        readCover: (key) => readStoredObject(store.provider, key),
        renderAlbumArt: render,
        ...(artworkCache ? { artworkCache } : {}),
      },
      warn: () => undefined,
    };
  }

  async function readAudio(key: string): Promise<Uint8Array> {
    const stream = await store.provider.readStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return new Uint8Array(Buffer.concat(chunks));
  }

  it('embeds title/album/artist and the session cover, preserving the audio frames', async () => {
    const seeded = await seedMp3Track({ sessionTitle: 'Deep Focus Coding', coverExt: 'webp' });
    const { render, sourceTypes } = fakeRenderAlbumArt();
    const result = await runEmbedTrackMetadata(deps(render), { trackId: seeded.trackId });
    expect(result.outcome).toBe('tagged');

    const tagged = await readAudio(seeded.audioKey);
    const parsed = readId3Tags(tagged)!;
    expect(parsed.album).toBe('Deep Focus Coding');
    expect(parsed.artist).toBe('Test Admin'); // falls back to the User name
    expect(parsed.hasArtwork).toBe(true);
    expect(parsed.userText[LIEDMOTIF_TAG_MARKER]).toBeTruthy();
    expect(stripId3v2(tagged)).toEqual(AUDIO);
    // The WebP cover went through the album-art rendition.
    expect(sourceTypes).toEqual(['image/webp']);

    // The asset row records the retagged size.
    const [asset] = await ctx.db
      .select({ byteSize: trackAudioAssets.byteSize })
      .from(trackAudioAssets)
      .where(eq(trackAudioAssets.trackId, seeded.trackId));
    expect(asset!.byteSize).toBe(tagged.length);
  });

  it("hands the cover's stored brandedness to the rendition and keeps it out of the marker", async () => {
    const seeded = await seedMp3Track({ sessionTitle: 'Badge Flow', coverExt: 'webp' });
    const { render, brandedFlags } = fakeRenderAlbumArt();
    expect((await runEmbedTrackMetadata(deps(render), { trackId: seeded.trackId })).outcome).toBe(
      'tagged',
    );
    // New cover rows store clean bytes, so the rendition is told to badge.
    expect(brandedFlags).toEqual([false]);

    // Brandedness is pixel treatment, not tag identity: flipping it must not
    // re-tag the file (the badge moving sites never causes a retag storm).
    await ctx.db.update(coverImages).set({ branded: true });
    expect((await runEmbedTrackMetadata(deps(render), { trackId: seeded.trackId })).outcome).toBe(
      'already_tagged',
    );
  });

  it('uses the profile Artist Name when set, and never a provider/model/app name', async () => {
    const seeded = await seedMp3Track({ sessionTitle: 'Evening Jazz' });
    await ctx.db
      .insert(listenerProfiles)
      .values({ ownerUserId: seeded.ownerUserId, artistName: 'DJ John' });
    const { render } = fakeRenderAlbumArt();
    await runEmbedTrackMetadata(deps(render), { trackId: seeded.trackId });
    const parsed = readId3Tags(await readAudio(seeded.audioKey))!;
    expect(parsed.artist).toBe('DJ John');
    expect(parsed.artist).not.toMatch(/suno|openrouter|gemini|liedmotif/i);
  });

  it('is idempotent: unchanged inputs skip the rewrite; a changed artist retags', async () => {
    const seeded = await seedMp3Track({ sessionTitle: 'Loop' });
    const { render } = fakeRenderAlbumArt();
    expect((await runEmbedTrackMetadata(deps(render), { trackId: seeded.trackId })).outcome).toBe(
      'tagged',
    );
    expect((await runEmbedTrackMetadata(deps(render), { trackId: seeded.trackId })).outcome).toBe(
      'already_tagged',
    );

    await ctx.db
      .insert(listenerProfiles)
      .values({ ownerUserId: seeded.ownerUserId, artistName: 'New Artist' });
    expect((await runEmbedTrackMetadata(deps(render), { trackId: seeded.trackId })).outcome).toBe(
      'tagged',
    );
    expect(readId3Tags(await readAudio(seeded.audioKey))!.artist).toBe('New Artist');
  });

  it("embeds a vocal track's lyrics as USLT alongside the other frames", async () => {
    const words = '[Verse]\nSpät in Berlin, nur dein Tisch.';
    const seeded = await seedMp3Track({ sessionTitle: 'Maschine voraus', lyrics: words });
    const { render } = fakeRenderAlbumArt();
    await runEmbedTrackMetadata(deps(render), { trackId: seeded.trackId });
    const parsed = readId3Tags(await readAudio(seeded.audioKey))!;
    expect(parsed.lyrics).toBe(words);
    expect(parsed.album).toBe('Maschine voraus');
  });

  it('retags exactly once when the words arrive after the file was tagged', async () => {
    const seeded = await seedMp3Track({ sessionTitle: 'Later Words' });
    const { render } = fakeRenderAlbumArt();
    expect((await runEmbedTrackMetadata(deps(render), { trackId: seeded.trackId })).outcome).toBe(
      'tagged',
    );
    expect(readId3Tags(await readAudio(seeded.audioKey))!.lyrics).toBeNull();

    // The lyrics backfill lands (route or a later poll) — the marker changes.
    await ctx.db
      .update(tracks)
      .set({ vocalMode: 'vocal', lyrics: 'Nur ein Gedanke' })
      .where(eq(tracks.id, seeded.trackId));
    expect((await runEmbedTrackMetadata(deps(render), { trackId: seeded.trackId })).outcome).toBe(
      'tagged',
    );
    expect(readId3Tags(await readAudio(seeded.audioKey))!.lyrics).toBe('Nur ein Gedanke');
    expect((await runEmbedTrackMetadata(deps(render), { trackId: seeded.trackId })).outcome).toBe(
      'already_tagged',
    );
  });

  it('retags exactly once after a rename: the file follows the Given Names', async () => {
    const seeded = await seedMp3Track({ sessionTitle: 'Derived Session' });
    const { render } = fakeRenderAlbumArt();
    expect((await runEmbedTrackMetadata(deps(render), { trackId: seeded.trackId })).outcome).toBe(
      'tagged',
    );

    // A Rename lands — the titles are read live, so the marker moves.
    await ctx.db
      .update(activitySessions)
      .set({ title: 'Given Session' })
      .where(eq(activitySessions.id, seeded.sessionId));
    await ctx.db.update(tracks).set({ title: 'Given Track' }).where(eq(tracks.id, seeded.trackId));
    expect((await runEmbedTrackMetadata(deps(render), { trackId: seeded.trackId })).outcome).toBe(
      'tagged',
    );
    const parsed = readId3Tags(await readAudio(seeded.audioKey))!;
    expect(parsed.album).toBe('Given Session');
    expect(parsed.title).toBe('Given Track');
    expect((await runEmbedTrackMetadata(deps(render), { trackId: seeded.trackId })).outcome).toBe(
      'already_tagged',
    );
  });

  it('embeds generation provenance as TCON/TYER/TBPM and TXXX frames', async () => {
    const seeded = await seedMp3Track({
      sessionTitle: 'Deep Focus Coding',
      userPrompt: 'calm music for late-night coding',
      stylePrompt: 'lofi hip hop, mellow, 80 bpm, instrumental',
      genreTags: ['lofi', 'ambient'],
      bpmEstimate: 87.6,
      providerModel: 'V4_5',
      rightsNote: 'Personal, non-commercial use.',
    });
    const { render } = fakeRenderAlbumArt();
    await runEmbedTrackMetadata(deps(render), { trackId: seeded.trackId });

    const parsed = readId3Tags(await readAudio(seeded.audioKey))!;
    expect(parsed.genre).toBe('lofi, ambient');
    expect(parsed.year).toBe(new Date().getFullYear());
    expect(parsed.bpm).toBe(88);
    expect(parsed.userText.Prompt).toBe('calm music for late-night coding');
    expect(parsed.userText.StylePrompt).toBe('lofi hip hop, mellow, 80 bpm, instrumental');
    expect(parsed.userText.Model).toBe('V4_5');
    expect(parsed.userText.Generator).toBe('Liedmotif');
    expect(parsed.userText.License).toBe('Personal, non-commercial use.');
  });

  it('omits provenance frames that have no data', async () => {
    const seeded = await seedMp3Track({ sessionTitle: 'Sparse' });
    const { render } = fakeRenderAlbumArt();
    await runEmbedTrackMetadata(deps(render), { trackId: seeded.trackId });

    const parsed = readId3Tags(await readAudio(seeded.audioKey))!;
    expect(parsed.genre).toBeNull();
    expect(parsed.bpm).toBeNull();
    // The generated year always exists (`tracks.createdAt`), as does the constant.
    expect(parsed.year).toBe(new Date().getFullYear());
    expect(parsed.userText.Generator).toBe('Liedmotif');
    expect(parsed.userText).not.toHaveProperty('Prompt');
    expect(parsed.userText).not.toHaveProperty('StylePrompt');
    expect(parsed.userText).not.toHaveProperty('Model');
    expect(parsed.userText).not.toHaveProperty('License');
  });

  it('retags exactly once when the BPM analysis lands after the first embed', async () => {
    const seeded = await seedMp3Track({ sessionTitle: 'Late BPM' });
    const { render } = fakeRenderAlbumArt();
    expect((await runEmbedTrackMetadata(deps(render), { trackId: seeded.trackId })).outcome).toBe(
      'tagged',
    );
    expect(readId3Tags(await readAudio(seeded.audioKey))!.bpm).toBeNull();

    await ctx.db.update(tracks).set({ bpmEstimate: 92.3 }).where(eq(tracks.id, seeded.trackId));
    expect((await runEmbedTrackMetadata(deps(render), { trackId: seeded.trackId })).outcome).toBe(
      'tagged',
    );
    expect(readId3Tags(await readAudio(seeded.audioKey))!.bpm).toBe(92);
    expect((await runEmbedTrackMetadata(deps(render), { trackId: seeded.trackId })).outcome).toBe(
      'already_tagged',
    );
  });

  it('writes the Track’s own frozen prompt, which a later Change Vibe never retags', async () => {
    const seeded = await seedMp3Track({
      userPrompt: 'calm music for coding',
      requestUserPrompt: 'calm music for coding',
    });
    const { render } = fakeRenderAlbumArt();
    expect((await runEmbedTrackMetadata(deps(render), { trackId: seeded.trackId })).outcome).toBe(
      'tagged',
    );
    expect(readId3Tags(await readAudio(seeded.audioKey))!.userText.Prompt).toBe(
      'calm music for coding',
    );

    // A Change Vibe extends the SESSION's history. This Track was generated
    // before it, so its file still carries its own prompt — nothing to retag.
    await ctx.db
      .update(activitySessions)
      .set({ userPrompt: 'calm music for coding\n\nmehr rockiger' })
      .where(eq(activitySessions.id, seeded.sessionId));

    expect((await runEmbedTrackMetadata(deps(render), { trackId: seeded.trackId })).outcome).toBe(
      'already_tagged',
    );
    expect(readId3Tags(await readAudio(seeded.audioKey))!.userText.Prompt).toBe(
      'calm music for coding',
    );
  });

  it('retags when the Track’s own frozen prompt changes', async () => {
    const seeded = await seedMp3Track({ requestUserPrompt: 'calm music for coding' });
    const { render } = fakeRenderAlbumArt();
    await runEmbedTrackMetadata(deps(render), { trackId: seeded.trackId });

    await ctx.db
      .update(generationRequests)
      .set({ userPrompt: 'calm music for coding\n\nmehr rockiger' })
      .where(eq(generationRequests.activitySessionId, seeded.sessionId));

    expect((await runEmbedTrackMetadata(deps(render), { trackId: seeded.trackId })).outcome).toBe(
      'tagged',
    );
    expect(readId3Tags(await readAudio(seeded.audioKey))!.userText.Prompt).toBe(
      'calm music for coding\n\nmehr rockiger',
    );
  });

  it('renders a shared cover once across tracks via the artwork cache, embedding identical art', async () => {
    const seeded = await seedMp3Track({ sessionTitle: 'Shared Cover', coverExt: 'webp' });
    // A second final MP3 in the same session — same effective cover.
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId: seeded.ownerUserId,
      activitySessionId: seeded.sessionId,
    });
    const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
    const siblingKey = `tracks/${seeded.ownerUserId}/fixture/sibling.mp3`;
    const siblingId = await createTrack(ctx.db, {
      ownerUserId: seeded.ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      audioStorageKey: siblingKey,
    });
    await store.provider.write({ key: siblingKey, body: AUDIO, mimeType: 'audio/mpeg' });

    const { render, sourceTypes } = fakeRenderAlbumArt();
    const embedDeps = deps(render, new AlbumArtCache());
    expect((await runEmbedTrackMetadata(embedDeps, { trackId: seeded.trackId })).outcome).toBe(
      'tagged',
    );
    expect((await runEmbedTrackMetadata(embedDeps, { trackId: siblingId })).outcome).toBe('tagged');

    // One render served both embeds; both files carry the artwork.
    expect(sourceTypes).toEqual(['image/webp']);
    expect(readId3Tags(await readAudio(seeded.audioKey))!.hasArtwork).toBe(true);
    expect(readId3Tags(await readAudio(siblingKey))!.hasArtwork).toBe(true);
  });

  it('skips non-MP3 finals without failing', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
    const trackId = await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      audioStorageKey: 'tracks/fixture/track.wav',
    });
    const { render } = fakeRenderAlbumArt();
    const result = await runEmbedTrackMetadata(deps(render), { trackId });
    expect(result.outcome).toBe('missing');
  });

  it('embeds text-only when the cover artwork cannot be rendered', async () => {
    const seeded = await seedMp3Track({ sessionTitle: 'No Art', coverExt: 'webp' });
    const render: RenderAlbumArt = async () => null;
    const result = await runEmbedTrackMetadata(deps(render), { trackId: seeded.trackId });
    expect(result.outcome).toBe('tagged');
    const parsed = readId3Tags(await readAudio(seeded.audioKey))!;
    expect(parsed.hasArtwork).toBe(false);
    expect(parsed.album).toBe('No Art');

    // The marker names what was written, so the art is retried once it renders.
    const retry = await runEmbedTrackMetadata(deps(fakeRenderAlbumArt().render), {
      trackId: seeded.trackId,
    });
    expect(retry.outcome).toBe('tagged');
    expect(readId3Tags(await readAudio(seeded.audioKey))!.hasArtwork).toBe(true);
  });
});
