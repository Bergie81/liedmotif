import { describe, expect, it } from 'vitest';
import { MAX_PLAYLIST_ORDER_TRACKS } from '@liedmotif/shared';
import {
  canDownloadPlaylist,
  formatPlaylistCardMeta,
  formatPlaylistMemberMetadata,
  hasUnloadedMembers,
  nextMemberCursor,
  playlistMenuRows,
  sameTrackOrder,
} from './playlist-view-model';

describe('playlistMenuRows', () => {
  const userPlaylist = {
    kind: 'user',
    coverImageId: null,
    trackCount: 4,
    downloadableTrackCount: 4,
  } as const;

  function ids(playlist: Parameters<typeof playlistMenuRows>[0]) {
    return playlistMenuRows(playlist).map((row) => row.id);
  }

  it('offers a hand-picked playlist its whole lifecycle', () => {
    expect(ids(userPlaylist)).toEqual([
      'add-tracks',
      'rename',
      'reorder',
      'cover',
      'download',
      'delete',
    ]);
  });

  it('drops the acts Favorites does not have', () => {
    expect(ids({ ...userPlaylist, kind: 'favorites' })).toEqual([
      'add-tracks',
      'reorder',
      'cover',
      'download',
    ]);
  });

  it('says which of the two cover acts it is', () => {
    const label = (playlist: Parameters<typeof playlistMenuRows>[0]) =>
      playlistMenuRows(playlist).find((row) => row.id === 'cover')?.label;
    expect(label(userPlaylist)).toBe('Add Playlist Cover');
    expect(label({ ...userPlaylist, coverImageId: 'cover-id' })).toBe('Edit Playlist Cover');
  });

  it('leaves reorder dark until there is an order to change, and past what one write carries', () => {
    const reorder = (trackCount: number) =>
      playlistMenuRows({ ...userPlaylist, trackCount }).find((row) => row.id === 'reorder');
    expect(reorder(1)?.disabled).toBe(true);
    expect(reorder(2)?.disabled).toBe(false);
    expect(reorder(MAX_PLAYLIST_ORDER_TRACKS)?.disabled).toBe(false);
    expect(reorder(MAX_PLAYLIST_ORDER_TRACKS + 1)).toMatchObject({
      disabled: true,
      note: 'Too many Tracks',
    });
  });

  it('ships Download, dark only while there is nothing to zip', () => {
    const download = (downloadableTrackCount: number) =>
      playlistMenuRows({ ...userPlaylist, downloadableTrackCount }).find(
        (row) => row.id === 'download',
      );
    expect(download(4)).toMatchObject({
      label: 'Download all Playlist Tracks',
      disabled: false,
    });
    expect(download(0)?.disabled).toBe(true);
  });

  it('keeps Download dark for members the zip cannot carry (Shared references, stream-only)', () => {
    // The zip route answers a bare 404 page for such a playlist; navigating
    // there leaves the app and stops the player.
    const rows = playlistMenuRows({ ...userPlaylist, trackCount: 4, downloadableTrackCount: 0 });
    expect(rows.find((row) => row.id === 'download')?.disabled).toBe(true);
    expect(canDownloadPlaylist({ downloadableTrackCount: 0 })).toBe(false);
    expect(canDownloadPlaylist({ downloadableTrackCount: 1 })).toBe(true);
  });
});

describe('formatPlaylistMemberMetadata', () => {
  it('reads duration first, then the genres that qualify it', () => {
    expect(
      formatPlaylistMemberMetadata({
        durationSeconds: 201,
        genreTags: ['ambient', 'neo-classical'],
      }),
    ).toBe('3:21 · AMBIENT, NEO-CLASSICAL');
  });

  it('keeps a phone row to two genres', () => {
    expect(
      formatPlaylistMemberMetadata({
        durationSeconds: 187,
        genreTags: ['ambient', 'downtempo', 'shoegaze'],
      }),
    ).toBe('3:07 · AMBIENT, DOWNTEMPO');
  });

  it('drops the genre half rather than trailing a separator', () => {
    expect(formatPlaylistMemberMetadata({ durationSeconds: 178, genreTags: [] })).toBe('2:58');
  });

  it('still says something for a track with no duration yet', () => {
    expect(formatPlaylistMemberMetadata({ durationSeconds: null, genreTags: ['lo-fi'] })).toBe(
      '—:—— · LO-FI',
    );
  });
});

describe('formatPlaylistCardMeta', () => {
  it('reads the member count first, then the total playtime in minutes', () => {
    expect(formatPlaylistCardMeta({ trackCount: 14, totalDurationSeconds: 3120 })).toBe(
      '14 Tracks · 52 min',
    );
    expect(formatPlaylistCardMeta({ trackCount: 1, totalDurationSeconds: 201 })).toBe(
      '1 Track · 3 min',
    );
  });

  it('never rounds a playing playlist down to nothing', () => {
    expect(formatPlaylistCardMeta({ trackCount: 1, totalDurationSeconds: 20 })).toBe(
      '1 Track · 1 min',
    );
  });

  it('speaks hours once minutes stop scanning', () => {
    expect(formatPlaylistCardMeta({ trackCount: 40, totalDurationSeconds: 4520 })).toBe(
      '40 Tracks · 1 hr 15 min',
    );
    expect(formatPlaylistCardMeta({ trackCount: 33, totalDurationSeconds: 7200 })).toBe(
      '33 Tracks · 2 hr',
    );
  });

  it('drops the playtime half for an empty playlist rather than claiming 0 min', () => {
    expect(formatPlaylistCardMeta({ trackCount: 0, totalDurationSeconds: 0 })).toBe('0 Tracks');
  });
});

describe('member paging derivations', () => {
  const members = (positions: number[]) => positions.map((position) => ({ position }));

  it('reports unloaded members from the loaded prefix against the live count', () => {
    expect(hasUnloadedMembers(members([0, 1]), 5)).toBe(true);
    expect(hasUnloadedMembers(members([0, 1]), 2)).toBe(false);
    expect(hasUnloadedMembers([], 0)).toBe(false);
  });

  it('derives the next cursor from the last loaded position, surviving a removal reindex', () => {
    expect(nextMemberCursor(members([0, 1, 2]))).toBe('2');
    // A removal reindexed the loaded prefix dense — the cursor follows it.
    expect(nextMemberCursor(members([0, 1]))).toBe('1');
    expect(nextMemberCursor([])).toBeNull();
  });
});

describe('sameTrackOrder', () => {
  it('is true only for the same ids in the same slots', () => {
    expect(sameTrackOrder([{ id: 'a' }, { id: 'b' }], ['a', 'b'])).toBe(true);
    expect(sameTrackOrder([{ id: 'a' }, { id: 'b' }], ['b', 'a'])).toBe(false);
    expect(sameTrackOrder([{ id: 'a' }], ['a', 'b'])).toBe(false);
  });
});
