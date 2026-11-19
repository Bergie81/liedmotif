import {
  EMPTY_SESSION_TRACK_ACTIVITY,
  type ActiveSessionOverview,
  type ActivitySessionStatus,
  type SessionListItem,
  type SessionSummary,
} from '@liedmotif/shared';
import { formatCollectionLength } from '@/components/library/library-view-model';

/**
 * Shape the My Sessions view: the live cross-route controller outranks the
 * server-known active session (same precedence as the app shell — it exists the
 * moment playback starts and its summary is the fresher of the two), and the
 * active Session never appears under Pinned or History. Card activity
 * (count, total length, genres) comes from the server view when it names the same
 * Session, else from the Session's own Pinned or History entry. The live summary is
 * frozen at engage time, so its cover can predate the generated art — the
 * controller's queue-poll cover (`liveCoverImageId`) outranks it, and only the
 * queue poll's `liveSessionStatus` says whether the live Session still runs: one it
 * reports stopped holds no Active now slot, however audible it still is, and stays
 * in Pinned or History.
 */
export function deriveSessionsListView({
  serverActive,
  liveSession,
  liveCoverImageId,
  liveSessionStatus,
  items,
  pinned,
}: {
  serverActive: ActiveSessionOverview | null;
  liveSession: SessionSummary | null;
  /** The live controller's self-updating session cover; null when nothing is
   * engaged (or the controller has not published one). */
  liveCoverImageId: string | null;
  /** The live Session's lifecycle as its queue poll last reported it. */
  liveSessionStatus: ActivitySessionStatus;
  items: SessionListItem[] | null;
  pinned: SessionListItem[];
}): {
  active: ActiveSessionOverview | null;
  pinned: SessionListItem[];
  earlier: SessionListItem[] | null;
  /** Nothing is live, or the list holds the live Session's Track activity: the
   *  server view names it while it still runs, or it has a Pinned or History row. */
  liveSessionKnown: boolean;
} {
  const liveId = liveSession?.id ?? null;
  const liveStopped = liveId !== null && liveSessionStatus === 'stopped';
  const live = liveStopped ? null : liveSession;
  const server = liveStopped && serverActive?.id === liveId ? null : serverActive;
  const base = live ?? server;
  const rows = [...(items ?? []), ...pinned];
  const liveSessionKnown =
    liveId === null || server?.id === liveId || rows.some((item) => item.id === liveId);
  if (!base) return { active: null, pinned, earlier: items, liveSessionKnown };
  const activity = server?.id === base.id ? server : rows.find((item) => item.id === base.id);
  // Only the live summary can be stale against the controller; the server view
  // is read fresh, so its own cover stands.
  const liveCover = live ? liveCoverImageId : null;
  const { trackCount, totalDurationSeconds, genreTags } = activity ?? EMPTY_SESSION_TRACK_ACTIVITY;
  return {
    active: {
      ...base,
      coverImageId: liveCover ?? base.coverImageId,
      trackCount,
      totalDurationSeconds,
      genreTags,
    },
    pinned: pinned.filter((item) => item.id !== base.id),
    earlier: items?.filter((item) => item.id !== base.id) ?? null,
    liveSessionKnown,
  };
}

export function formatSessionLastActive(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'recently';
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function formatTrackCount(count: number): string {
  if (count < 1) return 'No Tracks yet';
  return `${count} Track${count === 1 ? '' : 's'}`;
}

/** The count, then the total length once it is known and there is any. */
export function formatSessionTrackLine(trackCount: number, totalDurationSeconds: number): string {
  const count = formatTrackCount(trackCount);
  if (!totalDurationSeconds) return count;
  return `${count} · ${formatCollectionLength(totalDurationSeconds)}`;
}

const GENRE_LABELS: Readonly<Record<string, string>> = {
  lofi: 'Lo-fi',
  'drum-and-bass': 'Drum & Bass',
  'bossa-nova': 'Bossa Nova',
  'dream-pop': 'Dream Pop',
  'deep-house': 'Deep House',
  'hip-hop': 'Hip-hop',
};

/** The genre readout shared by the session surfaces and the player status
 * line: labeled tags joined with a middot; null when there are none, so
 * callers can `??` their own fallback line. */
export function formatGenreLine(tags: readonly string[]): string | null {
  if (tags.length === 0) return null;
  return tags.map(formatGenreTag).join(' · ');
}

export function formatGenreTag(tag: string): string {
  return (
    GENRE_LABELS[tag] ??
    tag
      .split('-')
      .filter(Boolean)
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join(' ')
  );
}
