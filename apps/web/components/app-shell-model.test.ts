import { describe, expect, it } from 'vitest';
import {
  deriveGenerationHeadroom,
  getPageIdentity,
  getPrimaryNavDestination,
  isSettingsDetailRoute,
  isPrimaryRouteActive,
  PRIMARY_NAV_ITEMS,
} from './app-shell-model';

describe('app shell model', () => {
  it('links every primary destination, appending the Lounge fifth', () => {
    expect(PRIMARY_NAV_ITEMS.map(({ label, href }) => ({ label, href }))).toEqual([
      { label: 'Home', href: '/' },
      { label: 'Search', href: '/search' },
      { label: 'Sessions', href: '/sessions' },
      { label: 'Library', href: '/library' },
      { label: 'Lounge', href: '/lounge' },
    ]);
  });

  it('resolves page identity and active navigation for nested routes', () => {
    expect(getPageIdentity('/')).toBe('Liedmotif');
    expect(getPageIdentity('/player')).toBe('Now Playing');
    expect(getPageIdentity('/sessions/abc')).toBe('Sessions');
    expect(getPrimaryNavDestination('/search')).toBe('/search');
    expect(getPageIdentity('/settings/profile')).toBe('Settings');
    expect(getPageIdentity('/stats')).toBe('Your Stats');
    // A Playlist names its shelf, while staying lit under the Library lamp.
    expect(getPageIdentity('/library')).toBe('Library');
    expect(getPageIdentity('/library/playlist/abc')).toBe('Playlists');
    // Outside the shell, but its wait still names where it is going.
    expect(getPageIdentity('/welcome')).toBe('Welcome');
    expect(getPageIdentity('/lounge')).toBe('Lounge');
    expect(getPrimaryNavDestination('/lounge')).toBe('/lounge');
    expect(isPrimaryRouteActive('/library/playlist/abc', '/library')).toBe(true);
    expect(isPrimaryRouteActive('/sessions', '/')).toBe(false);
    expect(getPrimaryNavDestination('/player')).toBe(null);
    expect(getPrimaryNavDestination('/player/queue')).toBe(null);
  });

  it('lets Settings details provide their own mobile back header', () => {
    expect(isSettingsDetailRoute('/settings')).toBe(false);
    expect(isSettingsDetailRoute('/settings/providers')).toBe(true);
    expect(isSettingsDetailRoute('/settings/cover-art')).toBe(true);
    expect(isSettingsDetailRoute('/library')).toBe(false);
  });

  it('derives truthful remaining Tracks from the tighter cost window', () => {
    expect(
      deriveGenerationHeadroom({
        dailyTracksUsed: 8,
        dailyTracksLimit: 40,
        monthlyTracksUsed: 390,
        monthlyTracksLimit: 400,
        minHeadroomTracksToStartSession: 5,
        budgetKind: 'rolling',
      }),
    ).toEqual({ remainingTracks: 10, remainingRatio: 0.025, window: 'month', critical: false });

    expect(
      deriveGenerationHeadroom({
        dailyTracksUsed: 8,
        dailyTracksLimit: 40,
        monthlyTracksUsed: 100,
        monthlyTracksLimit: 400,
        minHeadroomTracksToStartSession: 5,
        budgetKind: 'rolling',
      }),
    ).toEqual({ remainingTracks: 32, remainingRatio: 0.8, window: 'day', critical: false });

    expect(
      deriveGenerationHeadroom({
        dailyTracksUsed: 6,
        dailyTracksLimit: 10,
        monthlyTracksUsed: 0,
        monthlyTracksLimit: 100,
        minHeadroomTracksToStartSession: 5,
        budgetKind: 'rolling',
      }),
    ).toEqual({ remainingTracks: 4, remainingRatio: 0.4, window: 'day', critical: true });
  });

  it('handles exhausted and disabled windows without negative readouts', () => {
    expect(
      deriveGenerationHeadroom({
        dailyTracksUsed: 12,
        dailyTracksLimit: 10,
        monthlyTracksUsed: 0,
        monthlyTracksLimit: 0,
        minHeadroomTracksToStartSession: 5,
        budgetKind: 'rolling',
      }),
    ).toEqual({ remainingTracks: 0, remainingRatio: 0, window: 'day', critical: true });

    expect(
      deriveGenerationHeadroom({
        dailyTracksUsed: 10,
        dailyTracksLimit: 10,
        monthlyTracksUsed: 0,
        monthlyTracksLimit: 100,
        minHeadroomTracksToStartSession: 0,
        budgetKind: 'rolling',
      }),
    ).toEqual({ remainingTracks: 0, remainingRatio: 0, window: 'day', critical: true });
  });

  it('has no Tracks-left readout for an unbounded budget (the Admin with the Track ceiling off)', () => {
    expect(
      deriveGenerationHeadroom({
        dailyTracksUsed: 30,
        dailyTracksLimit: null,
        monthlyTracksUsed: 300,
        monthlyTracksLimit: null,
        minHeadroomTracksToStartSession: 5,
        budgetKind: 'rolling',
      }),
    ).toBeNull();
  });
});
