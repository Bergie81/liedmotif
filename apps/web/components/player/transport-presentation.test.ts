import { describe, expect, it } from 'vitest';
import { presentTransportToggle } from './transport-presentation';

describe('transport toggle presentation', () => {
  it('offers Pause while deferred autoplay is armed', () => {
    expect(
      presentTransportToggle({ isPlaying: false, preparing: true, playIntentPending: true }),
    ).toEqual({ label: 'Pause', icon: 'loading' });
  });

  it('offers Play after the preparing intent is disarmed', () => {
    expect(
      presentTransportToggle({ isPlaying: false, preparing: true, playIntentPending: false }),
    ).toEqual({ label: 'Play', icon: 'play' });
  });

  it('offers Pause during audible playback', () => {
    expect(
      presentTransportToggle({ isPlaying: true, preparing: false, playIntentPending: false }),
    ).toEqual({ label: 'Pause', icon: 'pause' });
  });
});
