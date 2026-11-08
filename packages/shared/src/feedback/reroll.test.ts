import { describe, expect, it } from 'vitest';
import { selectRerollReplacement, type SelectRerollInput } from './reroll';

// The sibling-first reroll chooser. Sibling beats a fresh call beats
// nothing — and an available sibling is preferred EVEN WHEN a fresh call is also
// possible (a pre-paid $0 reroll always wins over spend). The fresh call is the
// one branch the Session's mode gates, and it
// never buys a vibe the Session has left.
describe('selectRerollReplacement', () => {
  /** The only combination that reaches a fresh call; each case overrides one part. */
  const freshCall: SelectRerollInput = {
    sessionMode: 'keep_going',
    unplayedSiblingId: null,
    canGenerate: true,
    vibeSuperseded: false,
  };

  it('serves the unplayed sibling when one remains (a $0 reroll)', () => {
    expect(selectRerollReplacement({ ...freshCall, unplayedSiblingId: 'sib-1' })).toEqual({
      source: 'sibling',
      trackId: 'sib-1',
    });
  });

  it('serves the sibling when fresh generation is unavailable', () => {
    expect(
      selectRerollReplacement({ ...freshCall, unplayedSiblingId: 'sib-1', canGenerate: false }),
    ).toEqual({
      source: 'sibling',
      trackId: 'sib-1',
    });
  });

  it('spends a fresh call only when no sibling remains and budget allows', () => {
    expect(selectRerollReplacement(freshCall)).toEqual({
      source: 'generation',
    });
  });

  it('reports none when neither a sibling nor a fresh call is available (limit respected)', () => {
    expect(selectRerollReplacement({ ...freshCall, canGenerate: false })).toEqual({
      source: 'none',
    });
  });

  it('never spends a fresh call in Repeat mode, whatever the budget says', () => {
    expect(selectRerollReplacement({ ...freshCall, sessionMode: 'repeat' })).toEqual({
      source: 'none',
    });
  });

  it('still serves a pre-paid sibling in Repeat mode (an existing Track, $0)', () => {
    expect(
      selectRerollReplacement({
        ...freshCall,
        sessionMode: 'repeat',
        unplayedSiblingId: 'sib-1',
      }),
    ).toEqual({
      source: 'sibling',
      trackId: 'sib-1',
    });
  });

  it('never buys a fresh call for a Track from a vibe a Change Vibe replaced', () => {
    expect(selectRerollReplacement({ ...freshCall, vibeSuperseded: true })).toEqual({
      source: 'none',
    });
  });

  it('still serves a pre-paid sibling of a replaced vibe ($0)', () => {
    expect(
      selectRerollReplacement({ ...freshCall, vibeSuperseded: true, unplayedSiblingId: 'sib-1' }),
    ).toEqual({ source: 'sibling', trackId: 'sib-1' });
  });
});
