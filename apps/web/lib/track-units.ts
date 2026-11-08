export function normalizeTracksPerRequest(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 1;
}

export function providerTasksToTracks(tasks: number, tracksPerRequest: number): number {
  return tasks * normalizeTracksPerRequest(tracksPerRequest);
}

/** The smallest whole-call Track count at or above `tracks` — what a One-time total stores. */
export function roundUpToWholeCalls(tracks: number, tracksPerRequest: number): number {
  const perCall = normalizeTracksPerRequest(tracksPerRequest);
  return Math.ceil(tracks / perCall) * perCall;
}

export function tracksToProviderTasks(tracks: number, tracksPerRequest: number): number | null {
  const yieldPerRequest = normalizeTracksPerRequest(tracksPerRequest);
  return Number.isSafeInteger(tracks) && tracks >= 0 && tracks % yieldPerRequest === 0
    ? tracks / yieldPerRequest
    : null;
}

export function stepNonNegativeWholeValue(
  value: string,
  amount: number,
  max = Infinity,
  min = 0,
): string {
  const current = Number(value);
  const safeCurrent = Number.isSafeInteger(current) ? current : 0;
  return String(Math.min(max, Math.max(min, safeCurrent + amount)));
}

/** A limit figure as typed: a whole, non-negative count, or `null`. */
export function wholeLimitNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * One owner-facing Track figure as the provider calls it stores, or the message
 * naming why it cannot be one. Every surface that edits a Track ceiling parses
 * through here, so none of them can accept a figure the route would reject.
 * `minTasks` is the stored field's floor, named back in Tracks.
 */
export function trackLimitToTasks(
  raw: string,
  tracksPerRequest: number,
  minTasks: number,
): { tasks: number } | { error: string } {
  const tracks = wholeLimitNumber(raw);
  if (tracks === null) return { error: 'Enter a whole number (0 or more).' };
  const yieldPerRequest = normalizeTracksPerRequest(tracksPerRequest);
  const tasks = tracksToProviderTasks(tracks, yieldPerRequest);
  // A whole, non-negative count can only fail the conversion by not dividing evenly.
  if (tasks === null) return { error: `Enter a multiple of ${yieldPerRequest} Tracks.` };
  if (tasks < minTasks) return { error: `Enter ${minTasks * yieldPerRequest} or more.` };
  return { tasks };
}
