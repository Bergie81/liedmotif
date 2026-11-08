// The cold-start pending-generation surface: the
// queue endpoint derives a coarse user-facing STAGE from the persisted
// normalized provider status — never task ids or URLs — and the player renders
// staged copy from it. Failure/blocked statuses map to NO stage: the
// generation-status banner owns those.

import { describe, expect, it } from 'vitest';
import { PROVIDER_NORMALIZED_STATUSES } from '../state-machines/literals';
import { pendingGenerationStage, stagedProgressCopy } from './pending-generation';

describe('pendingGenerationStage', () => {
  it('maps the pre-provider and submit statuses to the submitting stage', () => {
    expect(pendingGenerationStage('queued')).toBe('submitting');
    expect(pendingGenerationStage('submitted')).toBe('submitting');
    // A parked uncertain submit still reads as "starting" to the listener; the
    // stall banner takes over if it never resolves.
    expect(pendingGenerationStage('submit_unknown')).toBe('submitting');
  });

  it('maps in-progress rendering to the generating stage', () => {
    expect(pendingGenerationStage('processing')).toBe('generating');
  });

  it('maps first-track/complete provider states to the finalizing stage', () => {
    expect(pendingGenerationStage('partially_ready')).toBe('finalizing');
    // `ready` with nothing playable yet means materialization is in flight.
    expect(pendingGenerationStage('ready')).toBe('finalizing');
  });

  it('maps every failure/blocked status to no stage (the banner owns those)', () => {
    const staged = new Set([
      'queued',
      'submitted',
      'submit_unknown',
      'processing',
      'partially_ready',
      'ready',
    ]);
    for (const status of PROVIDER_NORMALIZED_STATUSES) {
      if (staged.has(status)) continue;
      expect(pendingGenerationStage(status)).toBeNull();
    }
  });
});

describe('stagedProgressCopy', () => {
  it('advances the copy with the stage', () => {
    expect(stagedProgressCopy('submitting')).toBe('Starting your session…');
    expect(stagedProgressCopy('generating')).toBe('Composing your music…');
    expect(stagedProgressCopy('finalizing')).toBe('Almost there — preparing your first track…');
  });

  it('names the track being composed once an early title exists', () => {
    expect(stagedProgressCopy('generating', 'Neon Sunset')).toBe('Composing ‘Neon Sunset’…');
    // Only the composing stage names the track; the others keep their copy.
    expect(stagedProgressCopy('submitting', 'Neon Sunset')).toBe('Starting your session…');
    expect(stagedProgressCopy('finalizing', 'Neon Sunset')).toBe(
      'Almost there — preparing your first track…',
    );
  });

  it('degrades to the generic copy on an absent or blank title', () => {
    expect(stagedProgressCopy('generating', null)).toBe('Composing your music…');
    expect(stagedProgressCopy('generating', '  ')).toBe('Composing your music…');
  });
});
