// The cold-start pending-generation surface.
// While a Session has no playable track yet, the queue endpoint exposes the
// in-flight generation as a coarse user-facing STAGE derived from the
// persisted normalized provider status — stage names and timestamps only,
// never task ids, provider URLs, or prompts. The player renders staged copy
// from it; failure/blocked statuses map to NO stage because the
// generation-status banner owns those (and takes visual precedence).

import type { ProviderNormalizedStatus } from '../state-machines/literals';

/** The user-facing cold-start stages, in the order a healthy generation passes them. */
export const PENDING_GENERATION_STAGES = ['submitting', 'generating', 'finalizing'] as const;
export type PendingGenerationStage = (typeof PENDING_GENERATION_STAGES)[number];

/**
 * The stage a normalized provider status reads as, or null when the status is
 * not a healthy in-flight generation (failures/blocks — the banner's domain).
 * `submit_unknown` still reads as "starting" to the listener: it either
 * resolves or the stall banner takes over. `ready` with nothing playable yet
 * means track materialization is in flight — finalizing, not done.
 */
export function pendingGenerationStage(
  status: ProviderNormalizedStatus,
): PendingGenerationStage | null {
  switch (status) {
    case 'queued':
    case 'submitted':
    case 'submit_unknown':
      return 'submitting';
    case 'processing':
      return 'generating';
    case 'partially_ready':
    case 'ready':
      return 'finalizing';
    default:
      return null;
  }
}

/**
 * What Now Playing says while the first track is at `stage`. A teased track
 * title names what is being composed; the other stages keep their
 * copy, and an absent/blank title degrades to the generic line.
 */
export function stagedProgressCopy(
  stage: PendingGenerationStage,
  trackTitle?: string | null,
): string {
  switch (stage) {
    case 'submitting':
      return 'Starting your session…';
    case 'generating': {
      const title = trackTitle?.trim();
      return title ? `Composing ‘${title}’…` : 'Composing your music…';
    }
    case 'finalizing':
      return 'Almost there — preparing your first track…';
  }
}
