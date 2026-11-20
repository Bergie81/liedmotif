import type { LibraryTrackItem, TrackFlags, TrackSummary } from '@liedmotif/shared';

/** The retention facts a row carries: the two denormalized flags, plus curated
 *  membership. The flags travel together on every retention write; membership
 *  does not, because only the save picker can move it. */
type RowRetention = Pick<LibraryTrackItem, 'savedAt' | 'favoritedAt' | 'inCuratedPlaylist'>;

/**
 * Merge a settled retention write onto a Track row. One statement of it because
 * the Library list, its options sheet and the Search overlay all hold their own
 * copy of a row — and a merge that forgets `inCuratedPlaylist` leaves that row's
 * Add to Playlist reporting the state from before the commit.
 */
export function withSettledRetention<T extends RowRetention>(
  track: T,
  flags: TrackFlags,
  inCuratedPlaylist: boolean,
): T {
  return { ...track, savedAt: flags.savedAt, favoritedAt: flags.favoritedAt, inCuratedPlaylist };
}

export function formatTrackDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—:——';
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * A collection's total playtime on a card, in whole minutes (hours once past
 * one): cards are scanned by size, so per-second precision is noise. Any
 * playtime reads at least `1 min`.
 */
export function formatCollectionLength(seconds: number): string {
  const minutes = Math.max(Math.round(seconds / 60), 1);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/** How every list marks a failed Track: its final never arrived. */
export const FAILED_TRACK_NOTICE = 'Could Not Be Kept';

/**
 * The row mark for a Track that cannot play: a failed Track (its final never
 * arrived) says it could not be kept, so a saved one never reads as a healthy
 * row; any other Track without audio is simply unavailable.
 */
export function trackAudioNotice(
  track: Pick<TrackSummary, 'status' | 'audioUrl'>,
): typeof FAILED_TRACK_NOTICE | 'Audio Unavailable' | null {
  if (track.status === 'failed') return FAILED_TRACK_NOTICE;
  return track.audioUrl === null ? 'Audio Unavailable' : null;
}

/** Why a Track's Download row is off, or undefined while it can be downloaded. */
export function trackDownloadNote(
  track: Pick<TrackSummary, 'status' | 'downloadable'>,
): string | undefined {
  if (track.downloadable) return undefined;
  return track.status === 'failed' ? FAILED_TRACK_NOTICE : 'Still Generating';
}

export function getTrackAvailability(
  track: Pick<LibraryTrackItem, 'status' | 'audioUrl' | 'hasPlayed'>,
): { audioNotice: ReturnType<typeof trackAudioNotice>; hasPlayed: boolean } {
  return { audioNotice: trackAudioNotice(track), hasPlayed: track.hasPlayed };
}

/** Duration · Session title · up to three genres, in the row's uppercase mono style. */
export function formatLibraryTrackMetadata(
  track: Pick<LibraryTrackItem, 'durationSeconds' | 'originSessionTitle' | 'genreTags'>,
): string {
  const origin = track.originSessionTitle?.trim() || 'Untitled Session';
  return [
    formatTrackDuration(track.durationSeconds),
    origin.toUpperCase(),
    track.genreTags.slice(0, 3).join(', ').toUpperCase(),
  ]
    .filter(Boolean)
    .join(' · ');
}
