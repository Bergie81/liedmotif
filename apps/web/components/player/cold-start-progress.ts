// The cold-start staged-progress surface. Pure —
// the Now Playing card keeps only thin wiring — deciding what the card
// narrates while the first track of a Session is still generating.

import {
  presentGenerationStatus,
  stagedProgressCopy,
  type PendingGeneration,
  type SessionGenerationStatus,
} from '@liedmotif/shared';
import type { PlayerStatus } from './playback-controller-api';

/** A live cold-start narration: the staged copy plus the submit timestamp the
 * synthetic bar anchors on. They exist only together (both derive from the
 * same pending generation), so they travel as one value. */
export interface ColdStartNarration {
  copy: string;
  submittedAt: string;
}

/**
 * The staged narration replacing the generic "Preparing your session…" /
 * "Buffering the first tracks…" text, or null when the generic surface (or
 * none) should show. Staged copy needs ALL of: a preparing player, an empty
 * playable projection, and a healthy generation (a visible banner keeps
 * precedence — credits/rate-limit/stall/error must never hide behind
 * optimism). With a pending generation it narrates the backend stage; before
 * the first one arrives (the window right after mount, before a queue poll
 * lands) it reads as connecting to the provider, anchored on the player's
 * cold-start instant so the synthetic bar has a time base.
 */
export function coldStartStagedCopy(input: {
  status: PlayerStatus;
  queueLength: number;
  generationStatus: SessionGenerationStatus;
  statusMessageSafe: string | null;
  pendingGeneration: PendingGeneration | null;
  coldStartBeganAt: string;
}): ColdStartNarration | null {
  const preparing = input.status === 'loading' || input.status === 'waiting';
  if (!preparing || input.queueLength > 0) return null;
  const bannerVisible =
    presentGenerationStatus(input.generationStatus, input.statusMessageSafe).message != null;
  if (bannerVisible) return null;
  if (!input.pendingGeneration) {
    return { copy: 'Connecting to provider…', submittedAt: input.coldStartBeganAt };
  }
  return {
    copy: stagedProgressCopy(input.pendingGeneration.stage, input.pendingGeneration.trackTitle),
    submittedAt: input.pendingGeneration.submittedAt,
  };
}

/**
 * The expected wait from submit to the FIRST playable stream: the provider's
 * ~30-40s stream latency plus the worker's cold-start poll granularity. The
 * synthetic bar's time base — an expectation, not a promise.
 */
export const EXPECTED_FIRST_STREAM_MS = 45_000;

/** The asymptote the synthetic bar eases toward — full is reserved for the
 * REAL first-track arrival, so the bar can never claim a readiness that
 * hasn't happened. */
const SYNTHETIC_PROGRESS_CAP = 0.9;

/**
 * The synthetic bar's fill fraction after `elapsedMs`. The provider exposes no
 * real ETA or percentage, so this is explicitly time-based: an ease-out that
 * covers most of the bar across the expected stream-latency window, then
 * asymptotically HOLDS just under the cap — visibly still moving, honestly
 * never finished. Monotonic; nonsense elapsed values read as 0.
 */
export function syntheticProgressFraction(
  elapsedMs: number,
  windowMs: number = EXPECTED_FIRST_STREAM_MS,
): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  // The hold clamp keeps the never-full invariant even where the exponential
  // underflows to 0 (very long waits would otherwise read exactly the cap).
  return Math.min(
    SYNTHETIC_PROGRESS_CAP * (1 - Math.exp((-2 * elapsedMs) / windowMs)),
    SYNTHETIC_PROGRESS_CAP - 0.005,
  );
}

/**
 * What the cold-start block renders: the staged copy + synthetic
 * bar, the brief COMPLETION treatment (bar snaps full, visibly distinct) when
 * the staged wait resolves into a playable track, or nothing.
 */
export type ColdStartSurface =
  ({ kind: 'staged' } & ColdStartNarration) | { kind: 'complete' } | { kind: 'none' };

/**
 * The surface transition applied on every render tick. Completion is entered
 * ONLY from a live staged (or held completion) surface when a playable track
 * now exists — a staged wait that ends any other way (banner takeover, session
 * stop) drops straight to none, so the bar never fakes a finish. The component
 * ends a held completion with a timer; re-renders in between must not cut it
 * short, and the steady playing state never re-flashes it.
 */
export function resolveColdStartSurface(
  previous: ColdStartSurface,
  staged: ColdStartNarration | null,
  playableExists: boolean,
): ColdStartSurface {
  if (staged != null) return { kind: 'staged', ...staged };
  if (previous.kind !== 'none' && playableExists) return { kind: 'complete' };
  return { kind: 'none' };
}
