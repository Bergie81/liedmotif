import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  connectTestDb,
  createUser,
  GENERATION_FIXTURE_TABLES,
  seedReadyTrack,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '../testing';
import { addPlaylistTracks, createPlaylist, deletePlaylist } from './playlists-repo';
import { setPlaylistShared } from './playlist-share-repo';
import { isPlaylistLoungePinned, setPlaylistLoungePinned } from './pins-repo';

// Pins: a viewer's bookmark of a playlist in their Lounge,
// their own shares included — pure navigation, one row per (viewer, playlist)
// pair. A Pin grants nothing and must be hard-purged in the same transaction the
// playlist leaves the viewer's Lounge; re-share means re-pin.

const skip = !TEST_DATABASE_URL;

const TABLES = [
  'playlist_pins',
  'playlist_tracks',
  'playlists',
  ...GENERATION_FIXTURE_TABLES,
] as const;

let testDb: TestDb;

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('pins-repo-test');
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, TABLES);
});

/** An owner with a non-empty In-Lounge playlist, plus a second user (the visitor). */
async function seedSharedPlaylist(): Promise<{
  ownerUserId: string;
  viewerUserId: string;
  playlistId: string;
}> {
  const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
  const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Shared shelf' });
  await addPlaylistTracks(testDb.db, {
    ownerUserId,
    playlistId: playlist.id,
    trackIds: [trackId],
  });
  await setPlaylistShared(testDb.db, {
    ownerUserId,
    playlistId: playlist.id,
    audience: { kind: 'everyone' },
  });
  const viewerUserId = await createUser(testDb.db);
  return { ownerUserId, viewerUserId, playlistId: playlist.id };
}

async function pinRowCount(playlistId: string): Promise<number> {
  const result = await testDb.pool.query(
    'select count(*)::int as n from playlist_pins where playlist_id = $1',
    [playlistId],
  );
  return result.rows[0].n as number;
}

describe.skipIf(skip)('setPlaylistLoungePinned', () => {
  it('pins a foreign In-Lounge playlist idempotently — one row per pair', async () => {
    const { viewerUserId, playlistId } = await seedSharedPlaylist();

    const first = await setPlaylistLoungePinned(testDb.db, {
      viewerUserId,
      playlistId,
      pinned: true,
    });
    const again = await setPlaylistLoungePinned(testDb.db, {
      viewerUserId,
      playlistId,
      pinned: true,
    });

    expect(first).toEqual({ pinned: true });
    expect(again).toEqual({ pinned: true });
    expect(await pinRowCount(playlistId)).toBe(1);
    expect(await isPlaylistLoungePinned(testDb.db, { viewerUserId, playlistId })).toBe(true);
  });

  it('pins your own In-Lounge playlist like anybody else’s', async () => {
    const { ownerUserId, playlistId } = await seedSharedPlaylist();

    const selfPin = await setPlaylistLoungePinned(testDb.db, {
      viewerUserId: ownerUserId,
      playlistId,
      pinned: true,
    });

    expect(selfPin).toEqual({ pinned: true });
    expect(await isPlaylistLoungePinned(testDb.db, { viewerUserId: ownerUserId, playlistId })).toBe(
      true,
    );
  });

  it('refuses your own Private playlist and an unknown id alike', async () => {
    const { ownerUserId, playlistId } = await seedSharedPlaylist();
    await setPlaylistShared(testDb.db, { ownerUserId, playlistId, audience: null });

    const ownPrivate = await setPlaylistLoungePinned(testDb.db, {
      viewerUserId: ownerUserId,
      playlistId,
      pinned: true,
    });
    const unknown = await setPlaylistLoungePinned(testDb.db, {
      viewerUserId: ownerUserId,
      playlistId: randomUUID(),
      pinned: true,
    });

    expect(ownPrivate).toBeNull();
    expect(unknown).toBeNull();
    expect(await pinRowCount(playlistId)).toBe(0);
  });

  it('refuses pinning a Private playlist (nothing marks unshared content)', async () => {
    const { ownerUserId, viewerUserId, playlistId } = await seedSharedPlaylist();
    await setPlaylistShared(testDb.db, { ownerUserId, playlistId, audience: null });

    const result = await setPlaylistLoungePinned(testDb.db, {
      viewerUserId,
      playlistId,
      pinned: true,
    });

    expect(result).toBeNull();
    expect(await pinRowCount(playlistId)).toBe(0);
  });

  it('unpins idempotently — the visitor’s own action, no uniform refusal needed', async () => {
    const { viewerUserId, playlistId } = await seedSharedPlaylist();
    await setPlaylistLoungePinned(testDb.db, { viewerUserId, playlistId, pinned: true });

    const first = await setPlaylistLoungePinned(testDb.db, {
      viewerUserId,
      playlistId,
      pinned: false,
    });
    const again = await setPlaylistLoungePinned(testDb.db, {
      viewerUserId,
      playlistId,
      pinned: false,
    });

    expect(first).toEqual({ pinned: false });
    expect(again).toEqual({ pinned: false });
    expect(await pinRowCount(playlistId)).toBe(0);
  });
});

describe.skipIf(skip)('pin revocation purge', () => {
  it('unsharing purges the pins in the same transaction; re-share means re-pin', async () => {
    const { ownerUserId, viewerUserId, playlistId } = await seedSharedPlaylist();
    await setPlaylistLoungePinned(testDb.db, { viewerUserId, playlistId, pinned: true });

    await setPlaylistShared(testDb.db, { ownerUserId, playlistId, audience: null });
    expect(await pinRowCount(playlistId)).toBe(0);

    await setPlaylistShared(testDb.db, { ownerUserId, playlistId, audience: { kind: 'everyone' } });
    expect(await pinRowCount(playlistId)).toBe(0);
  });

  it('deleting the playlist removes its pins with it', async () => {
    const { ownerUserId, viewerUserId, playlistId } = await seedSharedPlaylist();
    await setPlaylistLoungePinned(testDb.db, { viewerUserId, playlistId, pinned: true });

    await deletePlaylist(testDb.db, { ownerUserId, playlistId });

    expect(await pinRowCount(playlistId)).toBe(0);
  });
});

describe.skipIf(skip)('the owner’s own Lounge pin', () => {
  it('goes on unshare like everyone else’s: re-share means re-pin', async () => {
    const { ownerUserId, viewerUserId, playlistId } = await seedSharedPlaylist();
    await setPlaylistLoungePinned(testDb.db, {
      viewerUserId: ownerUserId,
      playlistId,
      pinned: true,
    });
    await setPlaylistLoungePinned(testDb.db, { viewerUserId, playlistId, pinned: true });

    await setPlaylistShared(testDb.db, { ownerUserId, playlistId, audience: null });
    await setPlaylistShared(testDb.db, { ownerUserId, playlistId, audience: { kind: 'everyone' } });

    expect(await pinRowCount(playlistId)).toBe(0);
  });

  it('survives narrowing the audience — the playlist stays in the owner’s Lounge', async () => {
    const { ownerUserId, viewerUserId, playlistId } = await seedSharedPlaylist();
    await setPlaylistLoungePinned(testDb.db, {
      viewerUserId: ownerUserId,
      playlistId,
      pinned: true,
    });

    await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId,
      audience: { kind: 'selected', userIds: [viewerUserId] },
    });

    expect(await isPlaylistLoungePinned(testDb.db, { viewerUserId: ownerUserId, playlistId })).toBe(
      true,
    );
  });
});

describe.skipIf(skip)('pins under a selected audience', () => {
  it('only a User the playlist is shared with may pin it', async () => {
    const { ownerUserId, viewerUserId, playlistId } = await seedSharedPlaylist();
    const outsider = await createUser(testDb.db);
    await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId,
      audience: { kind: 'selected', userIds: [viewerUserId] },
    });

    expect(
      await setPlaylistLoungePinned(testDb.db, { viewerUserId, playlistId, pinned: true }),
    ).toEqual({ pinned: true });
    expect(
      await setPlaylistLoungePinned(testDb.db, {
        viewerUserId: outsider,
        playlistId,
        pinned: true,
      }),
    ).toBeNull();
  });

  it('narrowing the audience purges the dropped Users’ pins and keeps the rest', async () => {
    const { ownerUserId, viewerUserId: kept, playlistId } = await seedSharedPlaylist();
    const dropped = await createUser(testDb.db);
    await setPlaylistLoungePinned(testDb.db, { viewerUserId: kept, playlistId, pinned: true });
    await setPlaylistLoungePinned(testDb.db, { viewerUserId: dropped, playlistId, pinned: true });

    await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId,
      audience: { kind: 'selected', userIds: [kept] },
    });

    expect(await isPlaylistLoungePinned(testDb.db, { viewerUserId: kept, playlistId })).toBe(true);
    expect(await isPlaylistLoungePinned(testDb.db, { viewerUserId: dropped, playlistId })).toBe(
      false,
    );
  });
});
