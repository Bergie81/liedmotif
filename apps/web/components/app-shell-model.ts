import type { BudgetKind } from '@liedmotif/shared';

export type ShellUsage = {
  dailyTracksUsed: number;
  /** `null` when the budget is unbounded (the Admin with the Track ceiling off). */
  dailyTracksLimit: number | null;
  monthlyTracksUsed: number;
  monthlyTracksLimit: number | null;
  minHeadroomTracksToStartSession: number;
  budgetKind: BudgetKind;
};

export const PRIMARY_NAV_ITEMS = [
  { label: 'Home', href: '/', icon: 'home' },
  { label: 'Search', href: '/search', icon: 'search' },
  { label: 'Sessions', href: '/sessions', icon: 'sessions' },
  { label: 'Library', href: '/library', icon: 'library' },
  { label: 'Lounge', href: '/lounge', icon: 'lounge' },
] as const;

export type PrimaryNavItem = (typeof PRIMARY_NAV_ITEMS)[number];

export function isPrimaryRouteActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

export function getPrimaryNavDestination(pathname: string): string | null {
  return (
    PRIMARY_NAV_ITEMS.find((item) => item.href && isPrimaryRouteActive(pathname, item.href))
      ?.href ?? null
  );
}

export function getPageIdentity(pathname: string): string {
  if (pathname === '/') return 'Liedmotif';
  if (pathname === '/player' || pathname.startsWith('/player/')) return 'Now Playing';
  if (pathname === '/sessions' || pathname.startsWith('/sessions/')) return 'Sessions';
  // A Playlist is its own station in the bar even though the Library lamp stays
  // lit — the bar names the Library shelf you are standing on, not the one
  // playlist open on it.
  if (pathname.startsWith('/library/playlist/')) return 'Playlists';
  if (pathname === '/library' || pathname.startsWith('/library/')) return 'Library';
  if (pathname === '/settings' || pathname.startsWith('/settings/')) return 'Settings';
  if (pathname === '/lounge' || pathname.startsWith('/lounge/')) return 'Lounge';
  if (pathname === '/search' || pathname.startsWith('/search/')) return 'Search';
  if (pathname === '/stats') return 'Your Stats';
  if (pathname === '/welcome') return 'Welcome';
  return 'Liedmotif';
}

export function isSettingsDetailRoute(pathname: string): boolean {
  return pathname.startsWith('/settings/');
}

/** The chrome's Tracks-left readout, or `null` when there is no limit to count down to. */
export function deriveGenerationHeadroom(usage: ShellUsage): {
  remainingTracks: number;
  remainingRatio: number;
  /** Which window the figure belongs to, so a readout can name the period it
   *  covers. A One-time budget has no period: its total never returns. */
  window: 'day' | 'month' | 'total';
  critical: boolean;
} | null {
  const { dailyTracksLimit, monthlyTracksLimit } = usage;
  if (dailyTracksLimit === null || monthlyTracksLimit === null) return null;
  const dailyRemaining = Math.max(dailyTracksLimit - usage.dailyTracksUsed, 0);
  const monthlyRemaining = Math.max(monthlyTracksLimit - usage.monthlyTracksUsed, 0);
  const dailyRatio = dailyTracksLimit > 0 ? dailyRemaining / dailyTracksLimit : 0;
  const monthlyRatio = monthlyTracksLimit > 0 ? monthlyRemaining / monthlyTracksLimit : 0;
  const dailyIsBinding = dailyRemaining <= monthlyRemaining;
  const remainingRatio = dailyIsBinding ? dailyRatio : monthlyRatio;
  const remainingTracks = dailyIsBinding ? dailyRemaining : monthlyRemaining;
  const bindingWindow = dailyIsBinding ? 'day' : 'month';

  return {
    remainingTracks,
    remainingRatio,
    window: usage.budgetKind === 'oneTime' ? 'total' : bindingWindow,
    critical: remainingTracks === 0 || remainingTracks < usage.minHeadroomTracksToStartSession,
  };
}
