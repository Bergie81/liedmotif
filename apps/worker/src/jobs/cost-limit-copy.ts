// The buffer controller's safe, secret-free status copy: what a stopped or
// degraded Session tells its listener, and who can fix it. Mirrors the web's
// `headroom-copy` for the creation-time gate; the two say the same things
// about the same bounds.

import type { UserRole } from '@liedmotif/db';
import {
  oneTimeBudgetUsedUpMessage,
  type CostLimitWindow,
  type MemberCostLimitScope,
  type SessionGenerationStatus,
} from '@liedmotif/shared';

/**
 * The Member cost-limit copy, honest about who can fix it: a
 * personal-budget stop is something the Member spent and gets back at
 * rollover; a Pool stop is something they cannot influence. Neither implies
 * they could raise a limit, and neither names another Member.
 */
export const MEMBER_COST_LIMIT_MESSAGES = {
  member: 'You have used your tracks for now — replaying this session until your budget resets.',
  pool: 'The shared budget is used up — replaying this session until it resets.',
} as const;

/**
 * Why a tick that WOULD have generated bought nothing after all — a condition
 * the planner can only see under the lock, once it knows a submit is really
 * about to happen. Each blocks before the intent-to-spend row, and each names
 * the thing whose change lifts it (a generic provider error would send the
 * reader to the provider instead). The storage quota is instance-wide and only
 * the Admin can raise it, so its copy splits by role: a Member is told who can
 * fix it, never pointed at an admin-only setting.
 */
export const SUBMIT_BLOCK_MESSAGES = {
  storage_quota: {
    admin:
      'The configured storage quota is full, so no new tracks are being generated — ' +
      'raise it in Settings → Generation, or delete tracks you no longer keep.',
    member:
      'Storage on this server is full, so no new tracks are being generated — ' +
      'playing your ready tracks. The Admin needs to free space or raise the quota.',
  },
  own_voice:
    'This Session sings with your voice, but no ready voice profile is available — use Change Vibe to switch to generic vocals.',
} as const;

export type SubmitBlockReason = keyof typeof SUBMIT_BLOCK_MESSAGES;

/** The submit-block copy for the owner whose tick was blocked. */
export function submitBlockMessage(reason: SubmitBlockReason, role: UserRole): string {
  const copy = SUBMIT_BLOCK_MESSAGES[reason];
  return typeof copy === 'string' ? copy : copy[role];
}

/**
 * The provider blocks that no clock lifts. Both surface as `provider_error`,
 * whose canonical copy promises a recovery that never comes here, so each names
 * the change that actually re-opens generation. Both stay actionable for a
 * Member: the copy points at Change Vibe, never at admin-only settings.
 */
export const TERMINAL_BLOCK_MESSAGES = {
  blocked_by_policy: 'The music provider blocked this prompt — use Change Vibe to adjust it.',
  submit_rejected:
    'The music provider refused this request — nothing more is generated until the prompt or the provider setup changes. Use Change Vibe to adjust it.',
} as const;

/**
 * Provider maintenance clears on its own but waits as a `provider_error`,
 * whose canonical copy reads as a failed generation. Like the terminal copy it
 * names nothing a Member cannot act on. A Session with nothing to play is
 * normally still owed its first fill, which is not playback-gated, so it too
 * retries on its own once the cooldown lapses.
 */
export const PROVIDER_UNAVAILABLE_MESSAGES = {
  playing:
    'The music provider is under maintenance — generation resumes automatically when it is back.',
  noTracks:
    'No Tracks yet — the music provider is under maintenance; generation starts automatically when it is back.',
} as const;

/** The bound a cost-limit stop recorded: the Member half of the scope vocabulary, and its window. */
export interface StoredCostLimit {
  scope: MemberCostLimitScope | null;
  window: CostLimitWindow | null;
}

/**
 * A safe, secret-free user-facing message for the current generation status, or
 * null to leave the copy to the player.
 *
 * A message belongs here only when this tick knows something the status alone
 * does not — which budget refused, or a block whose fix the caller
 * can name. A generic provider block reads differently depending on whether the
 * session has anything to play, which only the player knows, so its copy lives
 * in the player's status mapping.
 */
export function safeStatusMessage(
  status: SessionGenerationStatus,
  costLimit: StoredCostLimit,
  adminName: string | null,
): string | null {
  if (status === 'repeat_cost_limit') {
    if (costLimit.window === 'total') return oneTimeBudgetUsedUpMessage(adminName);
    return costLimit.scope
      ? MEMBER_COST_LIMIT_MESSAGES[costLimit.scope]
      : 'Generation limit reached — replaying this session until it resets.';
  }
  return null;
}
