// Delivers listening reports from every playback surface.
//
// Surfaces report each Track they play and the server alone decides ownership,
// so a mixed Playlist or a Visitor's Lounge playback needs no client-side rule.
// A Track refused as not the listener's own stays refused for the page's life:
// ownership does not change under a playing Track, and repeating the question
// every few seconds would only be noise.

import { reportListening } from '@/lib/http/api-client';
import { makeUuid } from '@/lib/uuid';
import { createListeningMeter, type ListeningMeter, type ListeningReport } from './listening-meter';

type PostResult = { ok: true } | { ok: false; error: { code: string } };

export function createListeningSender(
  post: (report: ListeningReport) => Promise<PostResult>,
): (report: ListeningReport) => void {
  const refused = new Set<string>();
  return (report) => {
    if (refused.has(report.trackId)) return;
    post(report).then(
      (result) => {
        if (!result.ok && result.error.code === 'not_found') refused.add(report.trackId);
      },
      // Best-effort by contract.
      () => {},
    );
  };
}

const sendListening = createListeningSender(reportListening);

/** A meter wired to the app's reporting route — one per playing surface. */
export function createReportingMeter(): ListeningMeter {
  return createListeningMeter({ send: sendListening, now: Date.now, newOccurrenceId: makeUuid });
}

/**
 * Save what a meter holds when the page is hidden or closed: the last moment a
 * mobile browser reliably grants. An abrupt kill can still lose the final seconds.
 */
export function flushOnPageHide(meter: () => ListeningMeter | null): () => void {
  const flush = () => meter()?.flush();
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    window.removeEventListener('pagehide', flush);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
