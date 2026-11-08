// Own-voice helpers for the session-creation surfaces: the tri-state offer the
// UI renders and the block-before-spend gate the create/change-vibe/
// more-like-this routes run. There is never a silent fallback from "Use my
// voice" to generic vocals — an unusable request is rejected before any row or
// spend.

import {
  applyValidationOutcome,
  applyVoiceCreationOutcome,
  getReadyVoiceProfile,
  getVoiceProfile,
  getVoiceRecording,
  touchVoiceProfilePolled,
  type Database,
  type UserRole,
  type VoiceProfileRow,
} from '@liedmotif/db';
import type { MusicFailureReason, MusicVoiceApi } from '@liedmotif/providers';
import type { VoiceProfileView } from '@liedmotif/shared';
import { ownVoiceEnabled } from './env';
import { getMusicProvider } from '@/lib/providers';
import { cachedUserProfile } from './request-cache';

/** The minimal intent surface the own-voice gate reads — structural, so both
 * the shared wire type and the providers-side intent type satisfy it. */
interface OwnVoiceIntentLike {
  mode: 'prompt' | 'controls';
  ownVoice?: boolean;
  controls?: { vocal?: string; ownVoice?: boolean };
}

/** Bump when the consent notice copy changes materially. */
export const VOICE_CONSENT_VERSION = 'v1';

export const OWN_VOICE_UNSUPPORTED_MESSAGE =
  'The configured music provider or model cannot sing with your voice — check the music model in Settings.';
export const OWN_VOICE_NOT_READY_MESSAGE =
  'Your voice profile is not ready yet — finish setting it up in Settings → My voice.';
export const OWN_VOICE_NOT_OFFERED_MESSAGE =
  'Singing with your own voice is not available on this account.';

/** Whether this viewer may be offered their own voice at all: Voice Profiles
 * are Admin-only and the whole feature sits behind the instance's
 * `OWN_VOICE_ENABLED` switch. */
export function ownVoiceOfferedTo(role: UserRole | undefined): boolean {
  return ownVoiceEnabled() && role === 'admin';
}

/** A stored style as the app may act on it: with the feature switched off, an
 * own-voice opt-in reads as the generic singer the snapshot already describes,
 * so More Like This and Change Vibe from such a Track or Session continue
 * instead of refusing an opt-in the owner cannot see. */
export function honoredOwnVoice<T extends { useOwnVoice?: boolean }>(style: T): T {
  return style.useOwnVoice === true && !ownVoiceEnabled()
    ? { ...style, useOwnVoice: false }
    : style;
}

/** Whether the configured music provider/model can sing with a custom voice. */
export async function musicSupportsOwnVoice(): Promise<boolean> {
  try {
    return (await getMusicProvider()).getCapabilities().customVoice?.supported === true;
  } catch {
    return false;
  }
}

/**
 * How the create surfaces present "Use my voice" to this viewer:
 * `ready` — enabled toggle; `setup` — disabled toggle plus the Settings →
 * My voice hint (no ready profile, or the provider cannot sing with a custom
 * voice — the My voice page tells those apart); `hidden` — nothing renders at
 * all. Voice Profiles are Admin-only, so a Member — and everyone
 * while the feature is switched off — resolves `hidden` before any database
 * read.
 */
export type OwnVoiceOffer = 'ready' | 'setup' | 'hidden';

/** Resolve the offer for a viewer. Role is passed in, not looked up — every
 * caller already holds it from its guard, and a second read here would be a
 * second source for the same fact. */
export async function resolveOwnVoiceOffer(
  db: Database,
  viewer: { userId: string; role: UserRole },
): Promise<OwnVoiceOffer> {
  if (!ownVoiceOfferedTo(viewer.role)) return 'hidden';
  if (!(await musicSupportsOwnVoice())) return 'setup';
  return (await getReadyVoiceProfile(db, viewer.userId)) !== null ? 'ready' : 'setup';
}

/** Whether a create/change-vibe intent asks for the user's own voice. */
export function intentRequestsOwnVoice(input: OwnVoiceIntentLike): boolean {
  if (input.mode === 'prompt') return input.ownVoice === true;
  return input.controls?.vocal === 'vocal' && input.controls.ownVoice === true;
}

/**
 * The block-before-spend gate: a safe user-facing message when the own-voice
 * request cannot be honored, or null when it can.
 */
export async function ownVoiceBlockedMessage(
  db: Database,
  ownerUserId: string,
): Promise<string | null> {
  // Voice Profiles are Admin-only and the feature can be switched
  // off: either way the refusal fits the account — the other messages point at
  // admin-only Settings pages. The switch is checked first so a switched-off
  // instance never reads the role; the request-cached read joins the route
  // guard's own per-request role resolution instead of adding a query.
  if (!ownVoiceEnabled() || (await cachedUserProfile(db, ownerUserId))?.role !== 'admin') {
    return OWN_VOICE_NOT_OFFERED_MESSAGE;
  }
  if (!(await musicSupportsOwnVoice())) return OWN_VOICE_UNSUPPORTED_MESSAGE;
  if ((await getReadyVoiceProfile(db, ownerUserId)) === null) return OWN_VOICE_NOT_READY_MESSAGE;
  return null;
}

// --- Settings -> My voice (profile workflow) ---------------------------------

/** The provider's voice-setup workflow, or null when it offers none. */
export async function musicVoiceApi(): Promise<MusicVoiceApi | null> {
  try {
    return (await getMusicProvider()).voice ?? null;
  } catch {
    return null;
  }
}

/** Fixed safe copy per sanitized provider failure category. */
export function voiceFailureMessage(reason: MusicFailureReason | undefined): string {
  switch (reason) {
    case 'insufficient_credit':
      return 'The music provider is out of credits — top up, then try again.';
    case 'sensitive_content':
      return 'The music provider flagged the recording — try a different take.';
    default:
      return 'Voice setup failed at the music provider — try again with a new recording.';
  }
}

/** Provider polls are throttled per profile so a fast-polling client cannot
 *  turn every read into a provider call. */
const VOICE_POLL_THROTTLE_MS = 3_000;

/**
 * Refresh-on-read: when the profile is waiting on a provider task, poll it
 * (throttled) and persist the outcome. The status-guarded outcome writes make
 * a racing/late poll harmless; a failed status CALL leaves the row untouched
 * (still in-flight — the next read retries). Returns the freshest row.
 */
export async function refreshVoiceProfile(
  db: Database,
  profile: VoiceProfileRow,
): Promise<VoiceProfileRow> {
  const pending = profile.status === 'validating_source' || profile.status === 'creating_voice';
  if (!pending) return profile;
  const lastPolled = profile.lastPolledAt?.getTime() ?? 0;
  if (Date.now() - lastPolled < VOICE_POLL_THROTTLE_MS) return profile;
  const voice = await musicVoiceApi();
  if (!voice) return profile;

  await touchVoiceProfilePolled(db, { ownerUserId: profile.ownerUserId });
  try {
    if (profile.status === 'validating_source' && profile.providerValidationTaskId) {
      const result = await voice.getValidationStatus(profile.providerValidationTaskId);
      if (result.status === 'complete' && result.verificationPhrase) {
        await applyValidationOutcome(db, {
          ownerUserId: profile.ownerUserId,
          outcome: {
            status: 'awaiting_verification',
            verificationPhrase: result.verificationPhrase,
          },
        });
      } else if (result.status === 'failed') {
        await applyValidationOutcome(db, {
          ownerUserId: profile.ownerUserId,
          outcome: {
            status: 'failed',
            errorCode: result.failureReason ?? 'unknown',
            errorMessageSafe: voiceFailureMessage(result.failureReason),
          },
        });
      }
    } else if (profile.status === 'creating_voice' && profile.providerVoiceTaskId) {
      const result = await voice.getVoiceStatus(profile.providerVoiceTaskId);
      if (result.status === 'complete' && result.providerVoiceId) {
        await applyVoiceCreationOutcome(db, {
          ownerUserId: profile.ownerUserId,
          outcome: { status: 'ready', providerVoiceId: result.providerVoiceId },
        });
      } else if (result.status === 'failed') {
        await applyVoiceCreationOutcome(db, {
          ownerUserId: profile.ownerUserId,
          outcome: {
            status: 'failed',
            errorCode: result.failureReason ?? 'unknown',
            errorMessageSafe: voiceFailureMessage(result.failureReason),
          },
        });
      }
    }
  } catch {
    // A failed status CALL (transport etc.) is retried on the next read.
  }
  return (await getVoiceProfile(db, profile.ownerUserId)) ?? profile;
}

/** Build the safe UI view (never provider ids, URLs, or storage keys). */
export async function buildVoiceProfileView(
  db: Database,
  profile: VoiceProfileRow | null,
): Promise<VoiceProfileView> {
  const [voiceApi, generationSupported] = await Promise.all([
    musicVoiceApi(),
    musicSupportsOwnVoice(),
  ]);
  const setupSupported = voiceApi !== null;
  if (!profile) {
    return {
      status: 'none',
      displayName: 'My voice',
      language: '',
      verificationPhrase: null,
      errorMessageSafe: null,
      hasSourceRecording: false,
      hasVerificationRecording: false,
      setupSupported,
      generationSupported,
      availableForSessions: false,
    };
  }
  const lookup = { ownerUserId: profile.ownerUserId, voiceProfileId: profile.id };
  const [source, verification] = await Promise.all([
    getVoiceRecording(db, { ...lookup, kind: 'source' }),
    getVoiceRecording(db, { ...lookup, kind: 'verification' }),
  ]);
  return {
    status: profile.status,
    displayName: profile.displayName,
    language: profile.language ?? '',
    verificationPhrase: profile.verificationPhrase,
    errorMessageSafe: profile.errorMessageSafe,
    hasSourceRecording: source !== null,
    hasVerificationRecording: verification !== null,
    setupSupported,
    generationSupported,
    availableForSessions: profile.status === 'ready' && generationSupported,
  };
}
