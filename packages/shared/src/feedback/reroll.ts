// Pure dislike-reroll replacement choice, shared by the web Dislike route
// and the worker controller. A
// Dislike rerolls the SAME prompt — no steering, and never a text-LLM call (the
// prompt is reused on every branch). The reroll prefers the disliked track's
// already-generated, unplayed SIBLING (the other Track from the same ProviderJob — a
// pre-paid same-vibe alternate) before spending a fresh music-model call. It only
// spends when no unplayed sibling remains, and reports `none` when it can neither
// serve a sibling nor generate.
//
// The FRESH CALL is `keep_going`-only: "Play
// Existing Tracks" must never spend behind the owner's back. It is also never
// spent on a vibe the Session has left: after a
// Change Vibe the user asked for something else, so an old-vibe Track's reroll
// buys nothing. The sibling branch is mode- and revision-independent — a sibling
// IS an existing Track, already paid for.
//
// This maps directly to `dislikeTrackResponseSchema.replacementSource`. It lives in
// `@liedmotif/shared` so the web route and the worker reuse ONE chooser rather than
// each carrying their own — the sibling-first rule can never drift between them.

import type { SessionMode } from '../state-machines/literals';

export type ReplacementSource = 'sibling' | 'generation' | 'none';

export interface RerollReplacement {
  source: ReplacementSource;
  /** The sibling track id to serve (only for `source: 'sibling'`). */
  trackId?: string;
}

export interface SelectRerollInput {
  /** The disliked Track's Session mode — the authority over the fresh-call branch. */
  sessionMode: SessionMode;
  /** An already-generated, unplayed sibling (same ProviderJob), if one remains. */
  unplayedSiblingId: string | null;
  /** Whether a fresh music-model call is currently possible (budget/provider OK). */
  canGenerate: boolean;
  /** The disliked Track's request predates the Session's live Style Snapshot revision. */
  vibeSuperseded: boolean;
}

/**
 * Choose the reroll replacement: serve a pre-paid sibling if one is available
 * (a $0 reroll), else spend a fresh call while the Session's mode allows one
 * and the Track's vibe is still the live one, else nothing. No text-LLM call is
 * ever involved — the prompt is reused on every branch.
 */
export function selectRerollReplacement(input: SelectRerollInput): RerollReplacement {
  if (input.unplayedSiblingId) {
    return { source: 'sibling', trackId: input.unplayedSiblingId };
  }
  if (input.sessionMode === 'keep_going' && !input.vibeSuperseded && input.canGenerate) {
    return { source: 'generation' };
  }
  return { source: 'none' };
}
