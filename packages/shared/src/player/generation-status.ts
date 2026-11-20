// Generation-controller status → now-playing presentation.
//
// "Limit reached" and every other generation block is a property of the Buffer /
// generation controller, NOT a Session lifecycle state: the session stays `active`
// throughout — a degraded controller status never stops or pauses it. This pure
// mapping turns each `generationStatus` into the banner the player shows (tone +
// copy + whether to point at cost settings), so the UI never has to special-case
// the lifecycle. The server's `statusMessageSafe` (never a raw provider error)
// wins when present; the canonical copy here is the fallback so the player always
// has something safe to render.

import type { CostLimitScope } from '../limits';
import type { SessionGenerationStatus } from '../state-machines/literals';

/** Where the Session Repeat banner links the ADMIN for cost-limit settings. */
export const COST_SETTINGS_PATH = '/settings/limits';

/** Where a Member's cost-limit banner links: their read-only budget page. */
export const MY_BUDGET_PATH = '/settings/my-budget';

/** Visual severity for the now-playing status banner. */
export type GenerationStatusTone = 'ok' | 'info' | 'warn' | 'error';

/**
 * What the Session's Queue holds right now: what it can play, and what is on
 * the way. Both signals come from the same queue poll, and together they say
 * whether a degraded status is merely slow or a dead end.
 */
export interface QueueReadiness {
  /** Playable Tracks in the Session's live Queue projection. */
  readyTrackCount: number;
  /** Whether a generation is in flight right now. */
  generationInFlight: boolean;
}

/** How the player should render a generation-controller status. */
export interface GenerationStatusPresentation {
  /** The controller status this presentation describes. */
  status: SessionGenerationStatus;
  /** Banner severity. */
  tone: GenerationStatusTone;
  /** Short label, or null when nothing is surfaced (silent statuses). */
  title: string | null;
  /** Body copy, or null when nothing is surfaced (silent statuses). */
  message: string | null;
  /** True only for the cost-limit Session Repeat case. */
  isSessionRepeat: boolean;
  /** True only when a link to cost settings is useful (cost-limit). */
  showCostSettingsLink: boolean;
  /**
   * Where the cost-limit link points and what it says. A scoped (Member)
   * refusal links to the read-only My budget page — a Member must never be
   * invited to "adjust" a limit they cannot touch.
   */
  costSettingsPath: string;
  costSettingsLabel: string;
  /**
   * The Session is blocked, has no playable Track, and nothing will change that
   * on its own — a dead end, so the banner is the right place to offer a way
   * out. False while anything can still resolve it (a generation in flight, a
   * self-clearing block): offering to destroy a Session that is seconds from
   * working would be worse than saying nothing.
   */
  isStuck: boolean;
  /**
   * Always true: every generation status leaves the session `active` — a degraded
   * controller state NEVER stops or pauses the session. A lifecycle
   * invariant, not a claim that audio is audible (a Session blocked before its
   * first Track has nothing to play). Encoded as a constant so the invariant is
   * explicit at the call site.
   */
  keepsPlaying: true;
}

interface StatusCopy {
  tone: GenerationStatusTone;
  title: string | null;
  message: string | null;
  /** Copy for a Session that has no playable Track — set on every status whose
   *  `message` promises ready tracks, which is a lie during a cold start. */
  zeroTrackMessage?: string;
  /** True when the controller lifts this block by itself within moments: it
   *  backs off and retries (rate limit), or a submitted job is merely slow
   *  (stall). Such a Session is slow rather than stuck, however empty it is. */
  selfClearing?: true;
  isSessionRepeat?: boolean;
  showCostSettingsLink?: boolean;
}

const COPY: Record<SessionGenerationStatus, StatusCopy> = {
  ok: { tone: 'ok', title: null, message: null },
  repeat_cost_limit: {
    tone: 'info',
    title: 'Session Repeat',
    message: "Daily/monthly generation limit reached — repeating this session's own tracks.",
    // No reset is promised: a One-time budget never resets, and the player
    // cannot tell which window bound.
    zeroTrackMessage: 'No tracks yet — the generation limit was reached before the first one.',
    isSessionRepeat: true,
    showCostSettingsLink: true,
  },
  // Silent like `ok`: a legacy status only older stored rows hold (the controller
  // never emits it) — looping the session's own set is chosen, not a degrade.
  repeat_buffer_complete: { tone: 'ok', title: null, message: null },
  provider_credits: {
    tone: 'warn',
    title: 'Generation paused',
    message:
      'The music provider is out of credits — playing your ready tracks until the admin tops it up.',
    zeroTrackMessage:
      'No tracks yet — the music provider is out of credits until the admin tops it up.',
  },
  provider_rate_limited: {
    tone: 'warn',
    title: 'Generation backing off',
    message:
      'The music provider is busy — playing your ready tracks until generation resumes automatically in a few minutes.',
    zeroTrackMessage:
      'No tracks yet — the music provider is busy; generation resumes automatically in a few minutes.',
    selfClearing: true,
  },
  worker_stalled: {
    tone: 'warn',
    title: 'Catching up',
    message: 'Generation is catching up — playing your ready tracks in the meantime.',
    zeroTrackMessage: 'No tracks yet — generation is still catching up.',
    selfClearing: true,
  },
  provider_error: {
    tone: 'error',
    title: 'Generation error',
    message: 'Generation hit a problem — playing your ready tracks while it recovers.',
    zeroTrackMessage: 'No tracks yet — generation hit a problem before the first one landed.',
  },
};

/**
 * Map a `generationStatus` (and the server's optional safe message) to the banner the
 * player renders. Silent statuses (`ok`, the owner-chosen `repeat_buffer_complete` —
 * those whose canonical copy is null) surface nothing; every other status keeps the
 * session `active` and shows a safe, distinct line. A non-empty `statusMessageSafe`
 * overrides the canonical body (the server is authoritative for the safe message) —
 * except for silent statuses, which never surface one, and for a Session Repeat with
 * no ready Track, whose server copy promises a replay there is nothing to replay.
 *
 * `queue` describes what the session HAS: without it every status reads as its
 * steady-state self, which is what a session with tracks should say. With no
 * ready Track the blocked statuses name that absence instead of promising ready
 * tracks, and a block that nothing will lift reports itself `isStuck`.
 */
export function presentGenerationStatus(
  status: SessionGenerationStatus,
  statusMessageSafe?: string | null,
  scope?: CostLimitScope | null,
  queue?: QueueReadiness | null,
): GenerationStatusPresentation {
  const copy = COPY[status];
  const zeroTrackMessage = queue?.readyTrackCount === 0 ? copy.zeroTrackMessage : undefined;
  const canonical = zeroTrackMessage ?? copy.message;
  // The server's Session Repeat copy promises a replay, which a Session with
  // nothing to replay cannot keep, so its zero-track reason wins there.
  const serverMessage =
    statusMessageSafe?.trim() && !(zeroTrackMessage && copy.isSessionRepeat)
      ? statusMessageSafe
      : null;
  // A zero-track message exists only for a blocked status against an empty
  // Queue — half of a dead end. The rest is whether anything can still lift it.
  const isStuck =
    zeroTrackMessage !== undefined && !copy.selfClearing && queue?.generationInFlight === false;
  return {
    status,
    tone: copy.tone,
    title: copy.title,
    message: canonical === null ? null : (serverMessage ?? canonical),
    isSessionRepeat: copy.isSessionRepeat ?? false,
    showCostSettingsLink: copy.showCostSettingsLink ?? false,
    costSettingsPath: scope ? MY_BUDGET_PATH : COST_SETTINGS_PATH,
    costSettingsLabel: scope ? 'See Your Budget' : 'Adjust Cost Limits',
    isStuck,
    keepsPlaying: true,
  };
}
