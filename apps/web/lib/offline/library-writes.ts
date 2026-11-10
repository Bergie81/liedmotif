// What may change an Available-offline copy while the app is open, announced
// for the offline sync to follow. A successful write to Playlists or Tracks
// (adding, removing, Disliking, deleting…), or converting, deleting or renaming
// a Session, is a library write. A playing Session's new Track is announced as
// its local final lands, so a Keep Going Session's offline copy grows while it
// plays.
// A write the page on screen did not make itself (the Assistant's, from its
// panel beside the page) is announced as an outside write on top: the page
// could not follow it in its own state, so whatever lists the Library reloads.
// Announcing is a bare window event: nothing here knows about the device store
// or about who listens.

const LIBRARY_WRITE_EVENT = 'liedmotif:library-write';
const OUTSIDE_LIBRARY_WRITE_EVENT = 'liedmotif:outside-library-write';
const SESSION_TRACKS_EVENT = 'liedmotif:session-tracks-landed';
const LIBRARY_PATHS = [
  '/api/playlists',
  '/api/tracks',
  '/api/sessions/convert-to-playlist',
  '/api/sessions/delete',
  '/api/sessions/rename',
];

export function announceLibraryWrite(path: string): void {
  if (typeof window === 'undefined') return;
  if (!LIBRARY_PATHS.some((prefix) => path.startsWith(prefix))) return;
  window.dispatchEvent(new Event(LIBRARY_WRITE_EVENT));
}

export function onLibraryWrite(listener: () => void): () => void {
  window.addEventListener(LIBRARY_WRITE_EVENT, listener);
  return () => window.removeEventListener(LIBRARY_WRITE_EVENT, listener);
}

/** A library write that did not go through the page on screen. */
export function announceOutsideLibraryWrite(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(LIBRARY_WRITE_EVENT));
  window.dispatchEvent(new Event(OUTSIDE_LIBRARY_WRITE_EVENT));
}

export function onOutsideLibraryWrite(listener: () => void): () => void {
  window.addEventListener(OUTSIDE_LIBRARY_WRITE_EVENT, listener);
  return () => window.removeEventListener(OUTSIDE_LIBRARY_WRITE_EVENT, listener);
}

/**
 * Follows one Session's Queue reads: each call takes the Tracks the read shows
 * with a local final, and announces the Session when one of them is new to
 * this watch. The read window moving on past a Track announces nothing.
 */
export function watchSessionFinals(sessionId: string): (finalTrackIds: readonly string[]) => void {
  const seen = new Set<string>();
  return (finalTrackIds) => {
    const fresh = finalTrackIds.filter((trackId) => !seen.has(trackId));
    if (fresh.length === 0) return;
    for (const trackId of fresh) seen.add(trackId);
    window.dispatchEvent(new CustomEvent(SESSION_TRACKS_EVENT, { detail: sessionId }));
  };
}

export function onSessionTracksLanded(listener: (sessionId: string) => void): () => void {
  const heard = (event: Event) => listener((event as CustomEvent<string>).detail);
  window.addEventListener(SESSION_TRACKS_EVENT, heard);
  return () => window.removeEventListener(SESSION_TRACKS_EVENT, heard);
}
