// Back in Shuffle retraces the history; the cover swipe's preview must name the
// Track Back would really play, passing over the ones it skips (an expired
// offline copy), without stepping back itself.
import { describe, expect, it } from 'vitest';
import type { PlayableTrack } from './playable-track';
import { PlaybackTraversal } from './playback-traversal';

const track = (id: string) => ({ queueItemId: id, trackId: id }) as PlayableTrack;

describe('PlaybackTraversal.peekPrevious in Shuffle', () => {
  it('passes over skipped history and leaves the history as it was', () => {
    const tracks = ['own-1', 'lounge', 'own-2'].map(track);
    const traversal = new PlaybackTraversal();
    traversal.select('shuffle', tracks, 'own-1');
    traversal.commit('own-1', 'lounge');
    traversal.commit('lounge', 'own-2');

    const skipLounge = (t: PlayableTrack) => t.trackId === 'lounge';
    expect(traversal.peekPrevious(tracks, 'own-2', skipLounge)?.track.trackId).toBe('own-1');
    expect(traversal.peekPrevious(tracks, 'own-2')?.track.trackId).toBe('lounge');
  });
});
