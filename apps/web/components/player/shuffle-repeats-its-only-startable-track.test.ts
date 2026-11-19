// Shuffle loops like the ordered modes do: when the current Track is the only
// one that may start (the rest are expired offline copies), the next pick is
// that Track again rather than the end of playback.
import { describe, expect, it } from 'vitest';
import type { PlayableTrack } from './playable-track';
import { PlaybackTraversal } from './playback-traversal';

const track = (id: string) => ({ queueItemId: id, trackId: id }) as PlayableTrack;

describe('PlaybackTraversal.next in Shuffle', () => {
  it('repeats the current Track when every other one is passed over', () => {
    const tracks = ['lounge-1', 'own', 'lounge-2'].map(track);
    const traversal = new PlaybackTraversal();
    traversal.select('shuffle', tracks, 'own');

    const skipLounge = (t: PlayableTrack) => t.trackId.startsWith('lounge');
    expect(traversal.next(tracks, 'own', 2, skipLounge)).toEqual({ idx: 1, track: tracks[1] });
  });

  it('repeats a lone Track', () => {
    const tracks = [track('own')];
    const traversal = new PlaybackTraversal();
    traversal.select('shuffle', tracks, 'own');

    expect(traversal.next(tracks, 'own', 0)).toEqual({ idx: 0, track: tracks[0] });
  });

  it('ends when not even the current Track may start', () => {
    const tracks = ['lounge-1', 'lounge-2'].map(track);
    const traversal = new PlaybackTraversal();
    traversal.select('shuffle', tracks, 'lounge-1');

    expect(traversal.next(tracks, 'lounge-1', 1, () => true)).toBeNull();
  });
});
