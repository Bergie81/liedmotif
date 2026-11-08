import { describe, expect, it } from 'vitest';
import { resolveTrackPlayIntent } from './play-track-intent';

const SESSION = 'session-1';

describe('resolveTrackPlayIntent', () => {
  it('previews a track whose origin Session was deleted', () => {
    expect(resolveTrackPlayIntent({ id: 'track-1', originSessionId: null }, null)).toEqual({
      kind: 'preview',
    });
  });

  it('toggles in place when the track is already audible', () => {
    expect(resolveTrackPlayIntent({ id: 'track-1', originSessionId: SESSION }, 'track-1')).toEqual({
      kind: 'toggle',
    });
  });

  it('selects any other Track through the server', () => {
    const track = { id: 'track-2', originSessionId: SESSION };
    expect(resolveTrackPlayIntent(track, null)).toEqual({ kind: 'select', sessionId: SESSION });
    expect(resolveTrackPlayIntent(track, 'track-1')).toEqual({
      kind: 'select',
      sessionId: SESSION,
    });
  });
});
