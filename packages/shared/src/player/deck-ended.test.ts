import { describe, expect, it } from 'vitest';
import { deckEndedOutcome } from './deck-ended';

// When an <audio> deck fires `ended`, the player must report `ended` for the track
// THAT deck was carrying and advance only if that deck is still the active one.
// During a crossfade the active deck is switched to the incoming deck before the
// outgoing deck finishes, so a naive "report the active track / pause if inactive"
// handler never reports `ended` for a normally-blended outgoing track and would
// double-advance — corrupting the worker's play-history / eviction order.

interface T {
  trackId: string;
}
const T1: T = { trackId: 't-1' };
const T2: T = { trackId: 't-2' };

describe('deckEndedOutcome', () => {
  it('reports the active deck track and advances on a plain (no-crossfade) end', () => {
    const out = deckEndedOutcome({ activeDeck: 'a', loaded: { a: T1, b: null } }, 'a');
    expect(out.endedTrack).toBe(T1);
    expect(out.advance).toBe(true);
  });

  it('reports the OUTGOING track (not the swapped-in active one) and does not advance mid-crossfade', () => {
    // Crossfade armed: active already switched to incoming deck 'b' (carrying T2);
    // the outgoing deck 'a' (still carrying T1) now fires `ended`.
    const out = deckEndedOutcome({ activeDeck: 'b', loaded: { a: T1, b: T2 } }, 'a');
    expect(out.endedTrack).toBe(T1);
    expect(out.advance).toBe(false);
  });

  it('reports and advances when the now-active incoming deck ends', () => {
    const out = deckEndedOutcome({ activeDeck: 'b', loaded: { a: T1, b: T2 } }, 'b');
    expect(out.endedTrack).toBe(T2);
    expect(out.advance).toBe(true);
  });

  it('reports no track when the ended deck was already cleared (hard cut away)', () => {
    const out = deckEndedOutcome({ activeDeck: 'b', loaded: { a: null, b: T2 } }, 'a');
    expect(out.endedTrack).toBeNull();
    expect(out.advance).toBe(false);
  });
});
