// Playlist cursor resolution.
//
// Two pure mappings from the server-authoritative queue onto the player's numeric
// cursor. `resolveInitialPlaylistIndex`: a Stopped session resumes under its same
// identity — stored Style Snapshot AND queue position — reported as
// `currentQueueItemId` / `currentTrackId` on `getSessionQueue`, so playback restarts
// where the session left off rather than at index 0. `reanchorPlaylistIndex`: every
// later poll replaces the playlist wholesale, so the cursor must be re-derived from
// the track actually loaded, never trusted as a stable number. Framework-/DOM-free so
// the thin player wiring stays untested by necessity while this carries the coverage.

/** A playlist entry the resolver matches against (the player's playable items). */
export interface PlaylistCursorItem {
  queueItemId: string;
  trackId: string;
  /** True only when switch-now Change Vibe set this Queue item aside. */
  vibeSwitchSetAside: boolean;
}

/** The stored playback position from `getSessionQueue` (either field may be absent). */
export interface PlaylistCursor {
  currentQueueItemId?: string | null;
  currentTrackId?: string | null;
}

/**
 * The playable index a resumed session should start at: the stored
 * `currentQueueItemId` (preferred), else the stored `currentTrackId`, else the first
 * playable item (0). Either cursor that does not resolve to a playable item (e.g. the
 * current item isn't downloaded yet) is skipped, so resume degrades to the next
 * available signal rather than jumping to the wrong track.
 */
export function resolveInitialPlaylistIndex(
  playlist: ReadonlyArray<PlaylistCursorItem>,
  cursor: PlaylistCursor,
): number {
  if (playlist.length === 0) return 0;

  if (cursor.currentQueueItemId) {
    const byQueueItem = playlist.findIndex(
      (item) => item.queueItemId === cursor.currentQueueItemId,
    );
    if (byQueueItem >= 0) return byQueueItem;
  }

  if (cursor.currentTrackId) {
    const byTrack = playlist.findIndex((item) => item.trackId === cursor.currentTrackId);
    if (byTrack >= 0) return byTrack;
  }

  return 0;
}

/**
 * Re-anchor the player's numeric cursor after a poll replaces the playlist. Items can
 * disappear between polls (a dislike rejects one; eviction drops its audio), shifting
 * every later index left while the deck keeps playing the same track — so the cursor
 * must follow the track, not the number.
 *
 * - With a track loaded (`activeQueueItemId` non-null), the cursor is that track's
 *   index in the new playlist; if the track vanished entirely, the previous index is
 *   kept as the least-wrong guess until playback moves on.
 * - With nothing loaded (waiting for the buffer), the cursor means "the slot the next
 *   arriving track fills" and is clamped to the playlist length so it can never point
 *   past reachable items after the playlist shrinks.
 */
export function reanchorPlaylistIndex(
  playlist: ReadonlyArray<Pick<PlaylistCursorItem, 'queueItemId'>>,
  activeQueueItemId: string | null,
  previousIndex: number,
): number {
  if (activeQueueItemId) {
    const byQueueItem = playlist.findIndex((item) => item.queueItemId === activeQueueItemId);
    return byQueueItem >= 0 ? byQueueItem : previousIndex;
  }
  return Math.min(previousIndex, playlist.length);
}

/**
 * The index navigation (advance / Skip) should try next. Assumes `cursor` is
 * re-anchored (`reanchorPlaylistIndex` on every poll), so a loaded track that is
 * still in the playlist sits AT the cursor and next is `cursor + 1`. When the loaded
 * track has vanished from the projection (evicted, rejected elsewhere) the later
 * items have already shifted left into the cursor slot — next is the cursor itself,
 * otherwise the shifted-in track would be silently skipped. With nothing loaded the
 * cursor already parks on the next slot to play. Switch-now Change Vibe
 * set-asides are walked past; user-skipped items remain reachable after Back.
 */
export function nextPlaylistIndex(
  playlist: ReadonlyArray<Pick<PlaylistCursorItem, 'queueItemId' | 'vibeSwitchSetAside'>>,
  activeQueueItemId: string | null,
  cursor: number,
): number {
  const activeAtCursor =
    activeQueueItemId != null && playlist[cursor]?.queueItemId === activeQueueItemId;
  let next = activeAtCursor ? cursor + 1 : cursor;
  while (playlist[next]?.vibeSwitchSetAside) next += 1;
  return next;
}

/**
 * The index Back navigation should play, or `null` when nothing precedes the
 * cursor. Uniformly `cursor - 1`: with the loaded track re-anchored onto the
 * cursor each poll it is the previously played item; with the loaded track
 * vanished from the projection (later items shifted left INTO the cursor slot) or
 * nothing loaded (the waiting cursor parks one past the played set), `cursor - 1`
 * is still the last played item. `null` (not a clamp) so callers can fall back to
 * restarting the current track instead of replaying index 0.
 */
export function previousPlaylistIndex(
  playlist: ReadonlyArray<Pick<PlaylistCursorItem, 'queueItemId'>>,
  cursor: number,
): number | null {
  const previous = cursor - 1;
  return playlist[previous] ? previous : null;
}
