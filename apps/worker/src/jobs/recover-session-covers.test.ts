import { describe, expect, it, vi } from 'vitest';
import type { AgedSessionCoverGenerationId } from '@liedmotif/db';
import { scanAgedSessionCovers } from './recover-session-covers';

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
