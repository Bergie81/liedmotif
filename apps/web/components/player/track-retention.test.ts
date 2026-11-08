import { describe, expect, it } from 'vitest';
import {
  optimisticFavoriteFlags,
  settleTrackFlags,
  type TrackRetentionFlags,
} from './track-retention';

const NOW = '2026-07-16T10:00:00.000Z';
const SAVED = '2026-07-15T10:00:00.000Z';
const FAVORITED = '2026-07-15T11:00:00.000Z';

describe('Track retention transitions', () => {
  it('Favorite establishes the Save floor and Unfavorite preserves it', () => {
    const favorited = optimisticFavoriteFlags({ savedAt: null, favoritedAt: null }, true, NOW);
    expect(favorited).toEqual({ savedAt: NOW, favoritedAt: NOW });
    expect(optimisticFavoriteFlags(favorited, false, NOW)).toEqual({
      savedAt: NOW,
      favoritedAt: null,
    });
  });

  it('rolls back both flags when a retention write fails', () => {
    const previous: TrackRetentionFlags = { savedAt: SAVED, favoritedAt: FAVORITED };
    expect(settleTrackFlags(previous, null)).toEqual(previous);
    expect(settleTrackFlags(previous, { savedAt: null, favoritedAt: null })).toEqual({
      savedAt: null,
      favoritedAt: null,
    });
  });
});
