// Client-side download triggering. An authenticated same-origin download is a
// plain navigation: the Better Auth cookie rides along, the browser streams the
// attachment to disk with no JS memory cost, and the server's
// Content-Disposition names the file. Never fetch+blob — a session zip can be
// hundreds of MB. One helper so any future iOS-installed-PWA mitigation lands
// in a single place.

export function startFileDownload(url: string): void {
  window.location.assign(url);
}

export function trackDownloadUrl(trackId: string): string {
  return `/api/tracks/${trackId}/download`;
}

export function sessionDownloadUrl(sessionId: string): string {
  return `/api/sessions/${sessionId}/download`;
}

export function playlistDownloadUrl(playlistId: string): string {
  return `/api/playlists/${playlistId}/download`;
}
