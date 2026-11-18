import { describe, expect, it } from 'vitest';
import {
  nextPlaylistIndex,
  previousPlaylistIndex,
  reanchorPlaylistIndex,
  resolveInitialPlaylistIndex,
} from './resume-position';

// Resume must restart at the session's stored queue position. The pure index resolver the player feeds with the
// `getSessionQueue` cursor (`currentQueueItemId` preferred, then `currentTrackId`),
// then the next remaining Track after the stored position, and the Session's
// start only when nothing remains after it.

const playlist = [
  { queueItemId: 'qi-0', trackId: 't-0', vibeSwitchSetAside: false },
  { queueItemId: 'qi-1', trackId: 't-1', vibeSwitchSetAside: false },
  { queueItemId: 'qi-2', trackId: 't-2', vibeSwitchSetAside: false },
];

describe('resolveInitialPlaylistIndex', () => {
  it('defaults to 0 for an empty playlist', () => {
    expect(resolveInitialPlaylistIndex([], { currentQueueItemId: 'qi-2' })).toBe(0);
  });

  it('starts at the first playable item when no cursor is present', () => {
    expect(resolveInitialPlaylistIndex(playlist, {})).toBe(0);
    expect(
      resolveInitialPlaylistIndex(playlist, { currentQueueItemId: null, currentTrackId: null }),
    ).toBe(0);
  });

  it('starts at the stored currentQueueItemId (non-zero position)', () => {
    expect(resolveInitialPlaylistIndex(playlist, { currentQueueItemId: 'qi-2' })).toBe(2);
  });

  it('prefers currentQueueItemId over currentTrackId', () => {
    expect(
      resolveInitialPlaylistIndex(playlist, { currentQueueItemId: 'qi-2', currentTrackId: 't-0' }),
    ).toBe(2);
  });

  it('falls back to currentTrackId when the queue item id is absent', () => {
    expect(resolveInitialPlaylistIndex(playlist, { currentTrackId: 't-1' })).toBe(1);
  });

  it('falls back to currentTrackId when the queue item id is not playable yet', () => {
    // The current item exists server-side but is not yet in the playable playlist;
    // the track id still resolves, so resume lands on it rather than restarting.
    expect(
      resolveInitialPlaylistIndex(playlist, {
        currentQueueItemId: 'qi-not-downloaded',
        currentTrackId: 't-2',
      }),
    ).toBe(2);
  });

  // Slot positions with gaps: the stored slot at position 4 was removed by a
  // Dislike, so neither cursor resolves.
  const positioned = [
    { queueItemId: 'qi-0', trackId: 't-0', vibeSwitchSetAside: false, queuePosition: 0 },
    { queueItemId: 'qi-1', trackId: 't-1', vibeSwitchSetAside: false, queuePosition: 3 },
    { queueItemId: 'qi-2', trackId: 't-2', vibeSwitchSetAside: false, queuePosition: 5 },
    { queueItemId: 'qi-3', trackId: 't-3', vibeSwitchSetAside: false, queuePosition: 6 },
  ];
  const goneCursor = { currentQueueItemId: 'qi-gone', currentTrackId: 't-gone' };

  it('resumes at the next remaining Track after the stored position when the stored slot is gone', () => {
    expect(resolveInitialPlaylistIndex(positioned, { ...goneCursor, anchorPosition: 4 })).toBe(2);
  });

  it('resumes on the first unconsumed slot the read anchors on when no current item is stored', () => {
    expect(resolveInitialPlaylistIndex(positioned, { anchorPosition: 3 })).toBe(1);
  });

  it('walks past a switch-now set-aside after the stored position', () => {
    const withSetAside = positioned.map((item) =>
      item.queueItemId === 'qi-2' ? { ...item, vibeSwitchSetAside: true } : item,
    );
    expect(resolveInitialPlaylistIndex(withSetAside, { ...goneCursor, anchorPosition: 4 })).toBe(3);
  });

  it("starts at the Session's start when nothing remains after the stored position", () => {
    expect(resolveInitialPlaylistIndex(positioned, { ...goneCursor, anchorPosition: 7 })).toBe(0);
  });

  it('starts at the first item when neither cursor resolves and no position is reported', () => {
    expect(resolveInitialPlaylistIndex(positioned, goneCursor)).toBe(0);
  });
});

// Every poll replaces the playlist wholesale; the numeric cursor must be re-derived
// from the track the deck is actually carrying, or a removal (dislike/eviction)
// silently retargets Save/Dislike/reports at the wrong track.

describe('reanchorPlaylistIndex', () => {
  it('keeps the index when the playlist is unchanged', () => {
    expect(reanchorPlaylistIndex(playlist, 'qi-1', 1)).toBe(1);
  });

  it('follows the loaded track left after an earlier item is dropped', () => {
    // [T0,T1,T2,T3] playing T2 at index 2; T1 was disliked and dropped by the poll.
    const afterDislike = [
      { queueItemId: 'qi-0' },
      { queueItemId: 'qi-2' },
      { queueItemId: 'qi-3' },
    ];
    expect(reanchorPlaylistIndex(afterDislike, 'qi-2', 2)).toBe(1);
  });

  it('follows the loaded track right after items are prepended', () => {
    const afterPrepend = [{ queueItemId: 'qi-new' }, ...playlist];
    expect(reanchorPlaylistIndex(afterPrepend, 'qi-0', 0)).toBe(1);
  });

  it('keeps the previous index when the loaded track vanished entirely', () => {
    expect(reanchorPlaylistIndex(playlist, 'qi-gone', 2)).toBe(2);
  });

  it('keeps a waiting cursor pointing at the slot the next track will fill', () => {
    // Queue played out at 3 items; the cursor waits one past the end.
    expect(reanchorPlaylistIndex(playlist, null, 3)).toBe(3);
    // The awaited track arrives as a 4th item — the cursor now points at it.
    const grown = [...playlist, { queueItemId: 'qi-3' }];
    expect(reanchorPlaylistIndex(grown, null, 3)).toBe(3);
  });

  it('clamps a waiting cursor when the playlist shrinks', () => {
    const shrunk = [{ queueItemId: 'qi-2' }];
    expect(reanchorPlaylistIndex(shrunk, null, 3)).toBe(1);
    expect(reanchorPlaylistIndex([], null, 2)).toBe(0);
  });
});

// Navigation must not assume the loaded track still occupies the cursor slot: when
// it vanished from the projection (eviction, another client), the later items have
// shifted left INTO the slot, and `cursor + 1` would silently skip a ready track.

describe('nextPlaylistIndex', () => {
  it('is cursor + 1 while the loaded track still sits at the cursor', () => {
    expect(nextPlaylistIndex(playlist, 'qi-1', 1)).toBe(2);
  });

  it('is the cursor slot itself when the loaded track vanished from the projection', () => {
    // [T0,T1,T2] playing T1 at cursor 1; T1 vanished → [T0,T2]; next is T2 at 1.
    const withoutActive = [
      { queueItemId: 'qi-0', vibeSwitchSetAside: false },
      { queueItemId: 'qi-2', vibeSwitchSetAside: false },
    ];
    expect(nextPlaylistIndex(withoutActive, 'qi-1', 1)).toBe(1);
  });

  it('is the cursor slot when the vanished track was the last item', () => {
    // Downstream navigation then finds nothing there and waits/loops.
    expect(nextPlaylistIndex([{ queueItemId: 'qi-0', vibeSwitchSetAside: false }], 'qi-1', 1)).toBe(
      1,
    );
  });

  it('is the cursor slot when nothing is loaded (the waiting cursor)', () => {
    expect(nextPlaylistIndex(playlist, null, 2)).toBe(2);
  });

  it('walks past consecutive set-aside (skipped) entries — switch-now cutover leftovers', () => {
    const withSetAside = [
      { queueItemId: 'qi-0', vibeSwitchSetAside: false },
      { queueItemId: 'qi-1', vibeSwitchSetAside: true },
      { queueItemId: 'qi-2', vibeSwitchSetAside: true },
      { queueItemId: 'qi-3', vibeSwitchSetAside: false },
    ];
    expect(nextPlaylistIndex(withSetAside, 'qi-0', 0)).toBe(3);
    // Past the end when only set-aside entries remain.
    expect(nextPlaylistIndex(withSetAside.slice(0, 3), 'qi-0', 0)).toBe(3);
  });

  it('does not walk past a user-skipped Track from the current vibe after navigating back', () => {
    const afterChangeVibe = [
      { queueItemId: 'qi-1', vibeSwitchSetAside: false },
      { queueItemId: 'qi-2', vibeSwitchSetAside: false },
      { queueItemId: 'qi-3', vibeSwitchSetAside: false },
      { queueItemId: 'qi-4', vibeSwitchSetAside: false },
    ];

    expect(nextPlaylistIndex(afterChangeVibe, 'qi-2', 1)).toBe(2);
  });

  it('does not infer a switch-now set-aside from an older revision', () => {
    const afterPlayOutChange = [
      { queueItemId: 'qi-1', styleRevision: 1, vibeSwitchSetAside: false },
      {
        queueItemId: 'qi-2',
        styleRevision: 1,
        vibeSwitchSetAside: false,
      },
      { queueItemId: 'qi-3', styleRevision: 2, vibeSwitchSetAside: false },
    ];

    expect(nextPlaylistIndex(afterPlayOutChange, 'qi-1', 0)).toBe(1);
  });
});

// Back navigation steps to the item BEFORE the cursor slot: with the loaded track
// re-anchored onto the cursor each poll, cursor - 1 is the previously played item;
// with the loaded track vanished (items shifted left into the slot) or nothing
// loaded (the waiting cursor parks one past the played set), cursor - 1 is still
// the last played item — so the previous slot is uniform across all three cases.

describe('previousPlaylistIndex', () => {
  it('is cursor - 1 while the loaded track sits at the cursor', () => {
    expect(previousPlaylistIndex(playlist, 2)).toBe(1);
    expect(previousPlaylistIndex(playlist, 1)).toBe(0);
  });

  it('has no previous at the first item', () => {
    expect(previousPlaylistIndex(playlist, 0)).toBeNull();
  });

  it('has no previous on an empty playlist', () => {
    expect(previousPlaylistIndex([], 0)).toBeNull();
    expect(previousPlaylistIndex([], 1)).toBeNull();
  });

  it('points at the last played item while waiting past the end of the queue', () => {
    // Queue played out at 3 items; the waiting cursor parks at 3 — back re-plays qi-2.
    expect(previousPlaylistIndex(playlist, 3)).toBe(2);
  });
});
