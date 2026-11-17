import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { updateUsageLimits } from '@liedmotif/db';
import {
  connectTestDb,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import type { GeneratedImageProvider, LlmProvider } from '@liedmotif/providers';
import {
  resolveSessionCoverImageProvider,
  textLlmConfigured,
  type SessionCoverProviders,
} from './cover-image-provider';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const openRouter = { providerKey: 'openrouter' } as GeneratedImageProvider;
const sunoCover = { providerKey: 'suno-cover' } as GeneratedImageProvider;
const styledSession = { useStandardCover: false };
const unreadable = () => Promise.reject(new Error('credential cannot be decrypted'));

function sources(
  coverArt: GeneratedImageProvider | null,
  sunoCoverArt: GeneratedImageProvider | null,
): SessionCoverProviders {
  return { getCoverArt: async () => coverArt, getSunoCoverArt: async () => sunoCoverArt };
}
const standardSession = { useStandardCover: true };

describeIfDb('resolveSessionCoverImageProvider', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-cover-image-provider-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, ['app_settings']);
  });

  it('prefers the configured prompt-driven provider for styled sessions', async () => {
    await expect(
      resolveSessionCoverImageProvider(ctx.db, sources(openRouter, sunoCover), styledSession),
    ).resolves.toBe(openRouter);
  });

  it('falls back to the music-provider source with no image provider, no opt-in', async () => {
    await expect(
      resolveSessionCoverImageProvider(ctx.db, sources(null, sunoCover), styledSession),
    ).resolves.toBe(sunoCover);
  });

  it('falls back to the music-provider source when tailored cover art is off', async () => {
    await updateUsageLimits(ctx.db, { tailoredCoverArtEnabled: false });
    await expect(
      resolveSessionCoverImageProvider(ctx.db, sources(openRouter, sunoCover), styledSession),
    ).resolves.toBe(sunoCover);
  });

  it('resolves null when tailored cover art is off and the music source is unbuildable', async () => {
    await updateUsageLimits(ctx.db, { tailoredCoverArtEnabled: false });
    await expect(
      resolveSessionCoverImageProvider(ctx.db, sources(openRouter, null), styledSession),
    ).resolves.toBeNull();
  });

  it('gives a standard-cover session the Suno source even with an image provider', async () => {
    await expect(
      resolveSessionCoverImageProvider(ctx.db, sources(openRouter, sunoCover), standardSession),
    ).resolves.toBe(sunoCover);
  });

  it('stands a standard-cover session in with the prompt-driven provider when Suno is unbuildable', async () => {
    await expect(
      resolveSessionCoverImageProvider(ctx.db, sources(openRouter, null), standardSession),
    ).resolves.toBe(openRouter);
  });

  it('denies a standard-cover stand-in while tailored cover art is off', async () => {
    await updateUsageLimits(ctx.db, { tailoredCoverArtEnabled: false });
    await expect(
      resolveSessionCoverImageProvider(ctx.db, sources(openRouter, null), standardSession),
    ).resolves.toBeNull();
  });

  it('resolves a regeneration (no session) prompt-driven only', async () => {
    await expect(
      resolveSessionCoverImageProvider(ctx.db, sources(openRouter, sunoCover), null),
    ).resolves.toBe(openRouter);
  });

  // A broken music credential must not block a cover the image provider can paint.
  it('resolves only the source a cover can use', async () => {
    await expect(
      resolveSessionCoverImageProvider(
        ctx.db,
        { getCoverArt: async () => openRouter, getSunoCoverArt: unreadable },
        null,
      ),
    ).resolves.toBe(openRouter);
    await expect(
      resolveSessionCoverImageProvider(
        ctx.db,
        { getCoverArt: async () => openRouter, getSunoCoverArt: unreadable },
        styledSession,
      ),
    ).resolves.toBe(openRouter);
  });

  it('falls through to the other source when the first choice cannot resolve', async () => {
    await expect(
      resolveSessionCoverImageProvider(
        ctx.db,
        { getCoverArt: unreadable, getSunoCoverArt: async () => sunoCover },
        styledSession,
      ),
    ).resolves.toBe(sunoCover);
    await expect(
      resolveSessionCoverImageProvider(
        ctx.db,
        { getCoverArt: async () => openRouter, getSunoCoverArt: unreadable },
        standardSession,
      ),
    ).resolves.toBe(openRouter);
  });

  it('never sends a regeneration to the music-provider source', async () => {
    await expect(
      resolveSessionCoverImageProvider(ctx.db, sources(null, sunoCover), null),
    ).resolves.toBeNull();
  });

  it('resolves null when neither provider is buildable, without reading limits', async () => {
    await expect(
      resolveSessionCoverImageProvider(ctx.db, sources(null, null), standardSession),
    ).resolves.toBeNull();
  });
});

describe('textLlmConfigured', () => {
  it('is true only when a text LLM resolves, or its configuration cannot be read', async () => {
    const llm = { providerKey: 'openrouter' } as LlmProvider;
    await expect(textLlmConfigured(undefined)).resolves.toBe(false);
    await expect(textLlmConfigured(async () => null)).resolves.toBe(false);
    await expect(textLlmConfigured(async () => llm)).resolves.toBe(true);
    await expect(textLlmConfigured(unreadable)).resolves.toBe(true);
  });
});
