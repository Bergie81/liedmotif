import { describe, expect, it } from 'vitest';
import { resolveTrackDataPrompt } from './track-presentation';

describe('resolveTrackDataPrompt', () => {
  it('shows the prompt history the request froze, whatever the Session says now', () => {
    expect(resolveTrackDataPrompt('origin prompt', 'origin prompt\n\nmehr rockiger')).toBe(
      'origin prompt',
    );
  });

  it('shows no prompt for a request that froze an empty history, even after the Session gained one', () => {
    expect(resolveTrackDataPrompt('', 'mehr rockiger')).toBeNull();
  });

  it('falls back to the Session’s live prompt only for a legacy request that froze nothing', () => {
    expect(resolveTrackDataPrompt(null, 'calm music for coding')).toBe('calm music for coding');
  });
});
