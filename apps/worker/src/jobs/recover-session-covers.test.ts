import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activitySessions,
  reserveSessionCoverRegeneration,
  sessionCoverGenerations,
  type AgedSessionCoverGenerationId,
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
import type {
  GeneratedImageCapabilities,
  GeneratedImageProvider,
  LlmProvider,
} from '@liedmotif/providers';
import { createMockStorageProvider, storageKeys, type MockStorage } from '@liedmotif/storage';
import { createRecoverSessionCoversTask, scanAgedSessionCovers } from './recover-session-covers';

describe('aged Session Cover recovery scanner', () => {
  it('only identifies aged Session ids and delegates each one to ensureGenerated', async () => {
    const first = {
      id: crypto.randomUUID(),
      ownerUserId: 'owner-a',
      activitySessionId: crypto.randomUUID(),
      playlistId: null,
      trigger: 'initial',
    };
    const second = {
      id: crypto.randomUUID(),
      ownerUserId: 'owner-b',
      activitySessionId: null,
      playlistId: crypto.randomUUID(),
      trigger: 'user_regenerate',
    };
    const listAged = vi.fn(async () => [first, second]);
    const ensureGenerated = vi.fn(async () => undefined);

    await expect(
      scanAgedSessionCovers({
        listAged,
        ensureGenerated,
        now: new Date('2026-07-12T12:00:00.000Z'),
      }),
    ).resolves.toEqual({ identified: 2, attempted: 2 });

    expect(listAged).toHaveBeenCalledWith({
      updatedBefore: new Date('2026-07-12T11:50:00.000Z'),
      limit: 2,
    });
    expect(ensureGenerated.mock.calls).toEqual([[first], [second]]);
  });

  it('continues identifying work when one delegated recovery remains retryable', async () => {
    const rows = [
      {
        id: crypto.randomUUID(),
        ownerUserId: 'owner-a',
        activitySessionId: crypto.randomUUID(),
        playlistId: null,
        trigger: 'initial',
      },
      {
        id: crypto.randomUUID(),
        ownerUserId: 'owner-b',
        activitySessionId: crypto.randomUUID(),
        playlistId: null,
        trigger: 'initial',
      },
    ];
    const ensureGenerated = vi
      .fn<(row: AgedSessionCoverGenerationId) => Promise<void>>()
      .mockRejectedValueOnce(new Error('sanitized retry'))
      .mockResolvedValueOnce(undefined);

    await expect(
      scanAgedSessionCovers({
        listAged: async () => rows,
        ensureGenerated,
        now: new Date('2026-07-12T12:00:00.000Z'),
      }),
    ).resolves.toEqual({ identified: 2, attempted: 2 });
    expect(ensureGenerated).toHaveBeenCalledTimes(2);
  });
});

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('recover-session-covers job', () => {
  let ctx: TestDb;
  let store: MockStorage;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-recover-session-covers-test');
    store = createMockStorageProvider();
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
    await store?.cleanup();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, [...GENERATION_FIXTURE_TABLES, 'cover_images', 'app_settings']);
  });

  // The plan freezes before the provider runs, so a provider that refuses
  // still leaves the frozen plan to inspect.
  function refusingCoverArt(): GeneratedImageProvider {
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
    return {
      providerType: 'image',
      providerKey: 'fake-images',
      model: 'test/cover-model',
      getCapabilities: async () => capabilities,
      generate: async () => {
        throw new Error('refused in test');
      },
      validateCredentials: async () => ({ ok: true }),
    };
  }

  it('plans an aged regeneration with the configured Text AI: the stored pick, the wish as written', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      title: 'Harbor Lights',
      styleSnapshot: { mood: 'calm', energy: 'low', genreTags: ['ambient'] },
    });
    await ctx.db
      .update(activitySessions)
      .set({ coverStyle: 'auto', autoCoverStyle: 'manga' })
      .where(eq(activitySessions.id, sessionId));
    const attemptId = randomUUID();
    const coverImageId = randomUUID();
    await reserveSessionCoverRegeneration(ctx.db, {
      id: attemptId,
      ownerUserId,
      activitySessionId: sessionId,
      coverImageId,
      storageKey: storageKeys.generatedCover(ownerUserId, sessionId, coverImageId, 'webp'),
      userGuidance: 'by Picasso',
    });
    await ctx.pool.query(
      `update session_cover_generations set updated_at = now() - interval '1 hour' where id = $1`,
      [attemptId],
    );

    const task = createRecoverSessionCoversTask({
      db: ctx.db,
      storage: store.provider,
      getCoverArt: async () => refusingCoverArt(),
      getSunoCoverArt: async () => null,
      getLlm: async () => ({ providerKey: 'test-llm' }) as LlmProvider,
    });
    await task(undefined, {
      logger: { info: () => undefined, warn: () => undefined },
      addJob: async () => undefined,
    } as never);

    const [attempt] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.id, attemptId));
    expect(attempt!.plan).toMatchObject({ selectedStyle: 'auto', resolvedStyle: 'manga' });
    expect(attempt!.plan.prompt).toContain('User art direction: "by Picasso"');
  });
});
