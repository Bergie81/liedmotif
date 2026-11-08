import { describe, expect, it } from 'vitest';
import { resolveRowPreview, type RowPreview } from './use-track-row-playback';

const transport: RowPreview = { trackId: 'transport-track', state: 'playing' };

describe('resolveRowPreview', () => {
  it('lets an audible or paused preview speak for the row', () => {
    for (const state of ['playing', 'paused'] as const) {
      const preview: RowPreview = { trackId: 'preview-track', state };
      expect(resolveRowPreview(preview, transport)).toEqual(preview);
    }
  });

  it('falls back to the transport once the preview is idle or finished', () => {
    for (const state of ['idle', 'ended'] as const) {
      const preview: RowPreview = { trackId: 'preview-track', state };
      expect(resolveRowPreview(preview, transport)).toEqual(transport);
    }
  });

  it('reports the transport idle-and-empty when neither is playing', () => {
    const silent: RowPreview = { trackId: null, state: 'idle' };
    expect(resolveRowPreview({ trackId: null, state: 'idle' }, silent)).toEqual(silent);
  });
});
