// The 15 Liedmotif API contracts (the 13 core endpoints + resumeSession
// and listSessions): request + response Zod schemas (and inferred TS types) for the
// core Liedmotif API surface, plus an `API_CONTRACTS` registry that records each
// endpoint's route, auth requirement, and retry behavior.
//
// Everything is STRICT (unknown keys rejected) and reuses the state
// literals + the contract domain vocabularies, so the client, API routes, and
// worker cannot drift on shapes or value sets. The feedback model is
// EXACT: no `like`; Dislike = reroll/reject; Skip = soft-negative; Change Vibe
// re-styles in place; More Like This is a track-seeded Start Session that
// supersedes the active session. Track flags (savedAt/favoritedAt/dislikedAt) are
// the source of truth; `feedback_events` is the audit trail; there is no `ratings`.

import { z } from 'zod';
import {
  ACTIVITY_SESSION_STATUSES,
  QUEUE_ITEM_STATES,
  SESSION_GENERATION_STATUSES,
  SESSION_MODES,
  TRACK_RETENTION_CLASSES,
  TRACK_STATUSES,
} from '../state-machines/literals';
import { PENDING_GENERATION_STAGES } from '../player/pending-generation';
import {
  MAX_PLAYLIST_NAME_LENGTH,
  MAX_SESSION_TITLE_LENGTH,
  MAX_TRACK_TITLE_LENGTH,
} from '../text';
import { blendAnalysisSchema } from './blend';
import { BUDGET_KINDS } from './member-budgets';
import {
  deleteSessionCoverRequestSchema,
  deleteSessionCoverResponseSchema,
  regenerateSessionCoverRequestSchema,
  regenerateSessionCoverResponseSchema,
  selectSessionCoverRequestSchema,
  selectSessionCoverResponseSchema,
  sessionCoverStatusRequestSchema,
  sessionCoverStatusResponseSchema,
} from './session-covers';
import {
  deletePlaylistCoverRequestSchema,
  deletePlaylistCoverResponseSchema,
  playlistCoverStatusRequestSchema,
  playlistCoverStatusResponseSchema,
  regeneratePlaylistCoverRequestSchema,
  regeneratePlaylistCoverResponseSchema,
  selectPlaylistCoverRequestSchema,
  selectPlaylistCoverResponseSchema,
} from './playlist-covers';
import {
  apiResponse,
  clientIdSchema,
  isoDatetimeSchema,
  uuidSchema,
  type EndpointContract,
} from './common';
import {
  COVER_STYLE_CHOICES,
  ENERGY_LEVELS,
  FEEDBACK_TYPES,
  MAX_SESSION_AVOID_LENGTH,
  PLAYBACK_REPORT_TYPES,
  PROVIDER_TYPES,
  SESSION_LANGUAGES,
  VOCAL_MODES,
  VOICE_GENDERS,
} from './domain';

/** Max free-text prompt length accepted from the user (server may clamp further). */
export const MAX_USER_PROMPT_LENGTH = 2000;

// --- Reusable sub-schemas ----------------------------------------------------

/**
 * The Session Guardrails as the API carries them: the two
 * levels as 0–1 floats (the create card's 0–100 sliders convert), and the Avoid
 * text VERBATIM — the editable identity a later Change Vibe re-seeds, never the
 * merged negative tags. One shape spread into BOTH intent branches, so a
 * guardrail can never exist on one create tab and be rejected on another.
 */
const guardrailsShape = {
  styleStrength: z.number().min(0).max(1).optional(),
  novelty: z.number().min(0).max(1).optional(),
  avoid: z.string().max(MAX_SESSION_AVOID_LENGTH).optional(),
};

/**
 * Predefined controls a user picks; compiled to a Style Snapshot with NO text LLM.
 * Every field is optional — an empty object is valid and the
 * deterministic template fills sensible defaults (it is total by contract).
 */
export const structuredControlsSchema = z.strictObject({
  activity: z.string().max(120).optional(),
  mood: z.string().max(120).optional(),
  energy: z.enum(ENERGY_LEVELS).optional(),
  genres: z.array(z.string().min(1).max(60)).max(10).optional(),
  vocal: z.enum(VOCAL_MODES).optional(),
  /** Voice (gender) pick for vocal sessions; omitted = Any. */
  voice: z.enum(VOICE_GENDERS).optional(),
  /** Sing with the user's own voice profile (vocal sessions only; needs a ready
   * profile — the server blocks before spend when there is none). Omitted =
   * generic provider vocals. */
  ownVoice: z.boolean().optional(),
  /** Language for titles and vocals; omitted = Auto Detect (unspecified here —
   * there is no prompt to detect from, so the snapshot carries no language). */
  language: z.enum(SESSION_LANGUAGES).optional(),
  ...guardrailsShape,
});
export type StructuredControls = z.infer<typeof structuredControlsSchema>;

/** How many explicit genre picks may ride a free-text intent (the picker's cap). */
export const MAX_GENRE_PICKS = 3;

/** The prompt intent's required core, extended below with the fine-tune picks. */
const basePromptIntentSchema = z.strictObject({
  mode: z.literal('prompt'),
  // A blank prompt would compile to the generic fallback vibe and buy Tracks
  // nobody asked for. The prompt is kept as written, so this refines, not trims.
  prompt: z
    .string()
    .min(1)
    .max(MAX_USER_PROMPT_LENGTH)
    .refine((prompt) => prompt.trim().length > 0, 'Prompt is blank'),
});

/** The explicit fine-tune picks a prompt intent may carry. One shape, so a new
 * pick automatically joins both create and Change Vibe (which reuses the whole
 * create intent). */
const promptPicksShape = {
  /** Explicit genre picks (the describe-tab fine-tune) — so the words alone
   * don't have to name the genre. The expansion must honor them over the text. */
  genres: z.array(z.string().min(1).max(60)).max(MAX_GENRE_PICKS).optional(),
  /** Explicit energy/vocal/voice picks (the describe-tab fine-tune). Auto/Any is
   * omission; a present pick is authoritative over whatever the words suggest,
   * enforced deterministically on the expanded snapshot like genre picks. */
  energy: z.enum(ENERGY_LEVELS).optional(),
  vocal: z.enum(VOCAL_MODES).optional(),
  voice: z.enum(VOICE_GENDERS).optional(),
  /** Sing with the user's own voice profile (rides only with `vocal: 'vocal'`;
   * the server blocks before spend when no ready profile exists). */
  ownVoice: z.boolean().optional(),
  /** Explicit language pick for titles and vocals — authoritative over the
   * request's own language; omitted = Auto Detect (the expansion decides). */
  language: z.enum(SESSION_LANGUAGES).optional(),
  ...guardrailsShape,
};

const promptIntentSchema = basePromptIntentSchema.extend(promptPicksShape);

const controlsIntentSchema = z.strictObject({
  mode: z.literal('controls'),
  controls: structuredControlsSchema,
});

/** The two create inputs: a free-text prompt or structured controls. */
export const sessionIntentInputSchema = z.discriminatedUnion('mode', [
  promptIntentSchema,
  controlsIntentSchema,
]);
export type SessionIntentInput = z.infer<typeof sessionIntentInputSchema>;

/** A Change Vibe language pick: a concrete language, or `'auto'` = release the
 * running language for re-detection. Omission cannot mean that here, because
 * the server carries the running language forward for language-less intents. */
const changeVibeLanguageShape = {
  language: z.enum(['auto', ...SESSION_LANGUAGES]).optional(),
};

/** A Change Vibe with no message: only the changed picks, which adjust the
 * current Style Snapshot. Change Vibe only — a new Session has nothing to
 * adjust. A picks intent without any pick would change nothing, so it is
 * refused. */
const picksIntentSchema = z
  .strictObject({ mode: z.literal('picks'), ...promptPicksShape, ...changeVibeLanguageShape })
  .refine(
    ({ mode: _mode, ...picks }) =>
      Object.values(picks).some(
        (value) => value !== undefined && !(Array.isArray(value) && value.length === 0),
      ),
    'A picks-only change needs at least one pick',
  );

/** Change Vibe's intent: the create intent's shape, plus the explicit `'auto'`
 * language marker, plus the picks-only variant. Picks are explicit inputs the
 * overlay preselects from the session's current vibe; a present pick is
 * authoritative over the message text exactly as at create, and an absent one
 * leaves the derivation free. The server carries the running session's language
 * forward for intents without a language pick (an API-level fallback only). */
export const changeVibeIntentInputSchema = z.discriminatedUnion('mode', [
  promptIntentSchema.extend(changeVibeLanguageShape),
  controlsIntentSchema.extend({
    controls: structuredControlsSchema.extend(changeVibeLanguageShape),
  }),
  picksIntentSchema,
]);
export type ChangeVibeIntentInput = z.infer<typeof changeVibeIntentInputSchema>;

/**
 * App-routed audio: a SAME-ORIGIN path beginning with a single `/` and a
 * non-slash/backslash char. This rejects absolute (`https://…`),
 * protocol-relative (`//cdn…`), and backslash (`/\…`) URLs, so a provider/stream
 * URL can never reach the browser through an audio field.
 */
export const appAudioPathSchema = z
  .string()
  .regex(/^\/[^/\\]/, 'audio paths must be same-origin app paths');

/** A track as the player/library sees it. Audio is ALWAYS an app-route path. */
export const trackSummarySchema = z.strictObject({
  id: uuidSchema,
  title: z.string().nullable(),
  generatedArtistName: z.string().nullable(),
  status: z.enum(TRACK_STATUSES),
  durationSeconds: z.number().nonnegative().nullable(),
  coverImageId: uuidSchema.nullable(),
  /** See `appAudioPathSchema`: same-origin app path, never a provider URL. */
  audioUrl: appAudioPathSchema.nullable(),
  savedAt: isoDatetimeSchema.nullable(),
  favoritedAt: isoDatetimeSchema.nullable(),
  dislikedAt: isoDatetimeSchema.nullable(),
  /** Member of at least one playlist `isCuratedPlaylist` accepts. `savedAt`
   *  cannot stand in for this: ANY membership sets it, Favorites included, so
   *  only this can tell an Add to Playlist control the Track is filed. */
  inCuratedPlaylist: z.boolean(),
  /** The track's own `tracks.genre_tags` — ids on the structured path, free
   *  LLM-derived tags on the free-text path (unbounded, unlike the
   *  session-level activity projection's three-tag cap). */
  genreTags: z.array(z.string().min(1)),
  /** The TRACK's vocal mode (a Change Vibe can differ from the session's) —
   *  gates the player's lyrics affordance. */
  vocalMode: z.enum(VOCAL_MODES),
  /** True once the provider-written lyric text is captured (vocal tracks only);
   *  a vocal track without it is still "writing the words". */
  hasLyrics: z.boolean(),
  /** True when the track's downloaded, tagged local final can be fetched from
   *  `/api/tracks/<id>/download` — stricter than a non-null `audioUrl`, which a
   *  stream-only track also carries. Gates the "Download Track" menu rows. */
  downloadable: z.boolean(),
});
export type TrackSummary = z.infer<typeof trackSummarySchema>;

export const libraryTrackItemSchema = trackSummarySchema.extend({
  createdAt: isoDatetimeSchema,
  hasPlayed: z.boolean(),
  /** Null when the origin Session was deleted — such a track can only preview. */
  originSessionId: uuidSchema.nullable(),
  originSessionTitle: z.string().max(200).nullable(),
});
export type LibraryTrackItem = z.infer<typeof libraryTrackItemSchema>;

/** The resulting track flag state + derived retention class. */
export const trackFlagsSchema = z.strictObject({
  trackId: uuidSchema,
  savedAt: isoDatetimeSchema.nullable(),
  favoritedAt: isoDatetimeSchema.nullable(),
  dislikedAt: isoDatetimeSchema.nullable(),
  retentionClass: z.enum(TRACK_RETENTION_CLASSES),
});
export type TrackFlags = z.infer<typeof trackFlagsSchema>;

export const targetDurationMinutesSchema = z.number().int().positive().max(600);

/** Session duration target progress, carried by both the session summary and the queue poll. */
const sessionDurationFields = {
  targetDurationMinutes: targetDurationMinutesSchema.nullable().optional(),
  generatedDurationSeconds: z.number().nonnegative().optional(),
  unknownDurationTrackCount: z.number().int().nonnegative().optional(),
};

/**
 * A created/affected session as returned to the client. `status` is the two-value
 * lifecycle enum (Active/Stopped); the generation-controller state rides
 * ALONGSIDE it (never as a lifecycle value) so the player can render "why
 * generation isn't producing" (cost-limit Session Repeat, provider blocks) and the
 * session Cover/mode without a second fetch:
 *
 * - `generationStatus`  — the buffer/generation-controller status; a
 *                         degraded value (e.g. `repeat_cost_limit`) leaves `status`
 *                         `active`.
 * - `sessionMode`       — generation policy (Keep Going vs the voluntary Repeat loop).
 * - `coverImageId`      — the Session Cover (null until derived).
 * - `statusMessageSafe` — a safe, user-facing line for the current `generationStatus`
 *                         (never a raw provider error); null when nothing to surface.
 */
export const sessionSummarySchema = z.strictObject({
  ...sessionDurationFields,
  id: uuidSchema,
  status: z.enum(ACTIVITY_SESSION_STATUSES),
  title: z.string().nullable(),
  generationStatus: z.enum(SESSION_GENERATION_STATUSES),
  // Which bound a Member's cost-limit names: personal budget or the
  // shared Pool. Null for the Admin and for non-cost-limited statuses.
  generationStatusScope: z.enum(['member', 'pool']).nullable(),
  sessionMode: z.enum(SESSION_MODES),
  coverImageId: uuidSchema.nullable(),
  statusMessageSafe: z.string().nullable(),
  createdAt: isoDatetimeSchema,
  updatedAt: isoDatetimeSchema,
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

/**
 * The pinned per-source audio paths for one queue item's track. Each is a
 * same-origin `?asset=`-pinned app path that serves
 * EXACTLY that source or 404s — the prepared-deck ladder infers the
 * committed source kind from which pinned URL succeeded (`HTMLMediaElement`
 * exposes no response headers). Null when that asset doesn't exist (yet).
 */
export const queueItemAssetsSchema = z.strictObject({
  final: appAudioPathSchema.nullable(),
  stream: appAudioPathSchema.nullable(),
});
export type QueueItemAssets = z.infer<typeof queueItemAssetsSchema>;

/**
 * One queue slot (`activity_session_queue_items`) with its optional resolved
 * track, plus the generation-time blend identity and analysis the edge policy
 * needs:
 *
 * - `targetBpm`/`targetKey`/`styleRevision` come from the slot's GENERATION
 *   REQUEST (written at submit; null on legacy requests — and a null
 *   identity always forces a plain edge).
 * - `assets` are the pinned per-source audio paths (null track → both null).
 * - `blendAnalysis` is the track's measured analysis; null while `pending`,
 *   when there is no track, or when the stored analyzer version is stale
 *   (below `CURRENT_ANALYSIS_VERSION` — the server suppresses it).
 */
/**
 * The in-flight generation surfaced while the Session has NO playable track
 * yet: a coarse user-facing stage derived from
 * the persisted normalized provider status, plus the submit timestamp the
 * synthetic progress bar anchors on. Stage names and timestamps ONLY — never
 * provider URLs, task ids, or prompt content.
 */
export const pendingGenerationSchema = z.strictObject({
  stage: z.enum(PENDING_GENERATION_STAGES),
  submittedAt: isoDatetimeSchema,
  /** The first track's teased display title once the provider's text stage
   *  yielded one; null until then. Title text only — never lyric
   *  or prompt content. */
  trackTitle: z.string().nullable(),
});
export type PendingGeneration = z.infer<typeof pendingGenerationSchema>;

export const queueItemSchema = z.strictObject({
  id: uuidSchema,
  position: z.number().int().nonnegative(),
  state: z.enum(QUEUE_ITEM_STATES),
  /** True only for older-vibe material set aside by a switch-now Change Vibe. */
  vibeSwitchSetAside: z.boolean(),
  trackId: uuidSchema.nullable(),
  track: trackSummarySchema.nullable(),
  targetBpm: z.number().positive().nullable(),
  targetKey: z.string().nullable(),
  styleRevision: z.number().int().positive().nullable(),
  /** The resolved track's duration, surfaced at item level (the edge scheduler
   *  reads it here); null until a track exists. */
  durationSeconds: z.number().nonnegative().nullable(),
  assets: queueItemAssetsSchema,
  blendAnalysis: blendAnalysisSchema.nullable(),
});
export type QueueItem = z.infer<typeof queueItemSchema>;

// --- 1. startSession ---------------------------------------------------------

export const startSessionRequestSchema = z.strictObject({
  input: sessionIntentInputSchema,
  clientId: clientIdSchema,
  /** Optional Session duration target. */
  targetDurationMinutes: targetDurationMinutesSchema.optional(),
  /** Generated-cover art-direction choice; omitted → `auto` (Liedmotif picks).
   *  `custom` resolves server-side to the saved Custom style definition. */
  coverStyle: z.enum(COVER_STYLE_CHOICES).optional(),
  /** Standard covers from the music provider's own cover endpoint (no style
   *  control, no extra cost) instead of styled image-provider covers. Omitted →
   *  the owner's saved default; hand-tuned (controls) sessions default to true. */
  useStandardCover: z.boolean().optional(),
  /** Start this Session without the owner's listener profile: the profile and
   *  People stay out of the LLM prompts AND the generated cover's person
   *  references — the request alone is the creative direction. Omitted = false. */
  skipProfile: z.boolean().optional(),
});
export type StartSessionRequest = z.infer<typeof startSessionRequestSchema>;

export const startSessionResponseSchema = apiResponse(
  z.strictObject({
    session: sessionSummarySchema,
    /** The previously-active session this one superseded (stopped), if any. */
    supersededSessionId: uuidSchema.nullable(),
  }),
);
export type StartSessionResponse = z.infer<typeof startSessionResponseSchema>;

// --- 2. stopSession ----------------------------------------------------------

export const stopSessionRequestSchema = z.strictObject({ sessionId: uuidSchema });
export type StopSessionRequest = z.infer<typeof stopSessionRequestSchema>;

export const stopSessionResponseSchema = apiResponse(
  z.strictObject({ id: uuidSchema, status: z.enum(ACTIVITY_SESSION_STATUSES) }),
);
export type StopSessionResponse = z.infer<typeof stopSessionResponseSchema>;

// --- deleteSession (permanently delete a STOPPED session from My Sessions) ------
// Removes the session identity (row, queue, playback history) and reclaims its
// Ephemeral tracks' audio; Saved/Favorited tracks stay in the Library and spend
// accounting (provider jobs / generation requests) survives untouched. Refused
// with `conflict` while the session is active. With provider or cover work in
// flight it is a deferred delete: gone now, finished by the worker once the work
// settles.

export const deleteSessionRequestSchema = z.strictObject({ sessionId: uuidSchema });
export type DeleteSessionRequest = z.infer<typeof deleteSessionRequestSchema>;

export const deleteSessionResponseSchema = apiResponse(z.strictObject({ id: uuidSchema }));
export type DeleteSessionResponse = z.infer<typeof deleteSessionResponseSchema>;

// --- renameSession (Given Name: one-way, cosmetic, never steering) -------------
// The bound matches what derivation produces, so a Given Name can never exceed
// what any downstream consumer (Library contract, cover planner) already accepts.
// Blank is a validation error, not a reset — no derived name is retained.

export const renameSessionRequestSchema = z.strictObject({
  sessionId: uuidSchema,
  title: z.string().trim().min(1).max(MAX_SESSION_TITLE_LENGTH),
});
export type RenameSessionRequest = z.infer<typeof renameSessionRequestSchema>;

export const renameSessionResponseSchema = apiResponse(
  z.strictObject({ session: sessionSummarySchema }),
);
export type RenameSessionResponse = z.infer<typeof renameSessionResponseSchema>;

// --- convertSessionToPlaylist (a new Playlist of the Session's listed Tracks) ---

export const convertSessionToPlaylistRequestSchema = z.strictObject({ sessionId: uuidSchema });
export type ConvertSessionToPlaylistRequest = z.infer<typeof convertSessionToPlaylistRequestSchema>;

export const convertSessionToPlaylistResponseSchema = apiResponse(
  z.strictObject({ playlistId: uuidSchema, trackCount: z.number().int().positive() }),
);
export type ConvertSessionToPlaylistResponse = z.infer<
  typeof convertSessionToPlaylistResponseSchema
>;

// --- setSessionPinned ---
// A per-owner cap, enforced server-side; the UI shows no counter, only the
// refusal message once the cap is hit.

export const MAX_PINNED_SESSIONS = 10;

/** The refusal for a pin past the cap, wherever a pin is asked for. */
export const SESSION_PIN_LIMIT_MESSAGE = `You can pin up to ${MAX_PINNED_SESSIONS} Sessions. Unpin one to pin another.`;

export const setSessionPinnedRequestSchema = z.strictObject({
  sessionId: uuidSchema,
  pinned: z.boolean(),
});
export type SetSessionPinnedRequest = z.infer<typeof setSessionPinnedRequestSchema>;

export const setSessionPinnedResponseSchema = apiResponse(
  z.strictObject({ id: uuidSchema, pinned: z.boolean() }),
);
export type SetSessionPinnedResponse = z.infer<typeof setSessionPinnedResponseSchema>;

// --- resumeSession (re-activate a Stopped session in place) -----------------------
// Same identity (stored Style Snapshot + queue position), stops the current active
// session, and is NEVER gated by cost limits — Resume falls back to its own material
// (leftover Ephemeral tracks / Session Repeat). Distinct from moreLikeThis, which
// CREATES a new session from seed tracks.

export const resumeSessionRequestSchema = z.strictObject({
  sessionId: uuidSchema,
  clientId: clientIdSchema,
});
export type ResumeSessionRequest = z.infer<typeof resumeSessionRequestSchema>;

export const resumeSessionResponseSchema = apiResponse(
  z.strictObject({
    session: sessionSummarySchema,
    /** The previously-active session this Resume superseded (stopped), if any. */
    supersededSessionId: uuidSchema.nullable(),
  }),
);
export type ResumeSessionResponse = z.infer<typeof resumeSessionResponseSchema>;

// --- tryAgainSession (one more batch for a stuck Active session) -------------------
// The listener's consent to pay for one more provider batch when the Session has
// nothing to play. Recorded as a listener restart; the worker's buffer tick
// decides and spends under the usual limits.

export const tryAgainSessionRequestSchema = z.strictObject({ sessionId: uuidSchema });
export type TryAgainSessionRequest = z.infer<typeof tryAgainSessionRequestSchema>;

export const tryAgainSessionResponseSchema = apiResponse(z.strictObject({ id: uuidSchema }));
export type TryAgainSessionResponse = z.infer<typeof tryAgainSessionResponseSchema>;

// Play one of a session's own Tracks through the session (the track rows'
// tap-to-play): a Stopped session resumes positioned at that track, an Active
// one only moves its queue cursor. Like Resume, never cost-gated — it plays
// what the session already has.
export const playSessionTrackRequestSchema = z.strictObject({
  sessionId: uuidSchema,
  trackId: uuidSchema,
  clientId: clientIdSchema,
});
export type PlaySessionTrackRequest = z.infer<typeof playSessionTrackRequestSchema>;

export const playSessionTrackResponseSchema = resumeSessionResponseSchema;
export type PlaySessionTrackResponse = z.infer<typeof playSessionTrackResponseSchema>;

// --- setSessionMode (the Session's generation policy) ---
// User intent, and the only post-creation writer of `sessionMode` (creation
// seeds it from the owner's Buffer default; the worker merely consumes it):
// `keep_going` generates new Tracks indefinitely, `repeat` stops automatic
// generation and loops the Session's own Tracks at zero cost.

export const setSessionModeRequestSchema = z.strictObject({
  sessionId: uuidSchema,
  mode: z.enum(SESSION_MODES),
});
export type SetSessionModeRequest = z.infer<typeof setSessionModeRequestSchema>;

export const setSessionModeResponseSchema = apiResponse(
  z.strictObject({ session: sessionSummarySchema }),
);
export type SetSessionModeResponse = z.infer<typeof setSessionModeResponseSchema>;

// --- setSessionDuration ---

export const setSessionDurationRequestSchema = z.strictObject({
  sessionId: uuidSchema,
  /** Omitted preserves the target; null explicitly clears it. */
  targetDurationMinutes: targetDurationMinutesSchema.nullable().optional(),
  /** Omitted leaves the mode to the target rule: setting a target selects Keep Going. */
  sessionMode: z.enum(SESSION_MODES).optional(),
});
export type SetSessionDurationRequest = z.infer<typeof setSessionDurationRequestSchema>;

export const setSessionDurationResponseSchema = apiResponse(
  z.strictObject({ session: sessionSummarySchema }),
);
export type SetSessionDurationResponse = z.infer<typeof setSessionDurationResponseSchema>;

// --- 3. changeVibe (re-style the CURRENT session in place; never a new session) ---

export const changeVibeRequestSchema = z.strictObject({
  sessionId: uuidSchema,
  input: changeVibeIntentInputSchema,
  /** A duration edit riding the vibe change; omitted keeps the Session's target.
   *  A duration-only edit goes through `setSessionDuration` instead. */
  targetDurationMinutes: targetDurationMinutesSchema.nullable().optional(),
  /** Switch-now: cut over to the first new-vibe track as soon as it is playable,
   *  setting aside queued old-vibe tracks (they stay in the Session). Omitted =
   *  false — buffered tracks play out. */
  switchImmediately: z.boolean().optional(),
});
export type ChangeVibeRequest = z.infer<typeof changeVibeRequestSchema>;

export const changeVibeResponseSchema = apiResponse(
  // Same `id` as the request: Change Vibe keeps Session identity.
  z.strictObject({ session: sessionSummarySchema }),
);
export type ChangeVibeResponse = z.infer<typeof changeVibeResponseSchema>;

// --- 4. moreLikeThis (track-seeded Start Session; supersedes the active session) ---

/** How many Tracks one More Like This is seeded from at most. */
export const MAX_SEED_TRACKS = 10;

export const moreLikeThisRequestSchema = z.strictObject({
  seedTrackIds: z.array(uuidSchema).min(1).max(MAX_SEED_TRACKS),
  clientId: clientIdSchema,
  targetDurationMinutes: targetDurationMinutesSchema.optional(),
});
export type MoreLikeThisRequest = z.infer<typeof moreLikeThisRequestSchema>;

export const moreLikeThisResponseSchema = apiResponse(
  z.strictObject({
    session: sessionSummarySchema,
    supersededSessionId: uuidSchema.nullable(),
  }),
);
export type MoreLikeThisResponse = z.infer<typeof moreLikeThisResponseSchema>;

// --- 5. getSessionQueue ------------------------------------------------------

// A GET contract: `full` arrives as a URL flag (`?full=1`) and asks for every
// slot of the Session instead of the window (Shuffle traverses the whole
// Session, and only the device knows it is selected).
export const getSessionQueueRequestSchema = z.strictObject({
  sessionId: uuidSchema,
  full: z
    .enum(['1', 'true', '0', 'false'])
    .default('0')
    .transform((value) => value === '1' || value === 'true'),
});
export type GetSessionQueueRequest = z.infer<typeof getSessionQueueRequestSchema>;

/** The session's CURRENT vibe facets, projected from its Style Snapshot for the
 *  Change Vibe overlay's preselection — plus the stored structured controls of a
 *  controls-born vibe, which a picks-only change merges into. Exactly these
 *  fields — the snapshot's internals (style prompt, lyric context, seeds) and the
 *  prompt history stay server-only. */
export const sessionVibeSchema = z.strictObject({
  genreTags: z.array(z.string()),
  energy: z.enum(ENERGY_LEVELS).nullable(),
  vocalMode: z.enum(VOCAL_MODES),
  /** Null = Any. */
  voiceGender: z.enum(VOICE_GENDERS).nullable(),
  /** Whether the vibe sings with the user's own voice profile. */
  ownVoice: z.boolean(),
  /** The resolved language (explicit pick or detected); '' = none resolved. */
  language: z.string(),
  /** The frozen Session Guardrails. Null = a vibe created before they existed,
   *  which the overlay shows as the domain defaults. */
  styleStrength: z.number().nullable(),
  novelty: z.number().nullable(),
  /** The Avoid text VERBATIM ('' = none) — never the compiled negative tags,
   *  which also carry system terms the user never typed. */
  avoid: z.string(),
  /** The stored structured controls for a controls-mode vibe; null otherwise. */
  controls: structuredControlsSchema.nullable(),
});
export type SessionVibe = z.infer<typeof sessionVibeSchema>;

export const getSessionQueueResponseSchema = apiResponse(
  z.strictObject({
    ...sessionDurationFields,
    sessionId: uuidSchema,
    sessionStatus: z.enum(ACTIVITY_SESSION_STATUSES),
    // The live Session mode, so a New music change made on another device
    // reaches this player's status with the target above.
    sessionMode: z.enum(SESSION_MODES).optional(),
    // The generation-controller state rides ALONGSIDE the two-value `sessionStatus`
    // so the player can render "why generation isn't producing" (cost-limit
    // Session Repeat, provider blocks) straight from a queue poll — no second fetch.
    generationStatus: z.enum(SESSION_GENERATION_STATUSES),
    // Which bound a Member's cost-limit names (member/pool); null
    // for the Admin and non-cost-limited statuses.
    generationStatusScope: z.enum(['member', 'pool']).nullable(),
    statusMessageSafe: z.string().nullable(),
    // The Session Cover rides along so the player picks up the async generated
    // cover mid-session from its regular queue poll — no second fetch.
    coverImageId: uuidSchema.nullable(),
    // The session's LIVE style revision (bumped atomically by Change Vibe). The
    // player watches it move to clear a repeat-one loop pin on a Change Vibe — in
    // any tab, since the signal is the queue poll, not a local callback.
    styleRevision: z.number().int().positive(),
    currentTrackId: uuidSchema.nullable(),
    currentQueueItemId: uuidSchema.nullable(),
    // The slot position the read anchors on: the stored current slot's (kept
    // when its Track was removed), else the first unconsumed slot's, else one
    // past the last. Resume starts at the first remaining Track from here when
    // the stored Track is gone. Null only for a Session without slots.
    anchorPosition: z.number().int().nonnegative().nullable(),
    // Playable Tracks elided by the server-side read window (`items` holds the
    // last ~30 played slots plus everything from the current item forward);
    // the player adds them to its Track numbering.
    earlierTracks: z.number().int().nonnegative(),
    items: z.array(queueItemSchema),
    // The Session's first playable slot, present only while the window leaves
    // it out: ordered play wraps from the last Track to it, so a long Session
    // repeats whole. Absent when `items` already starts the Session.
    loopHead: queueItemSchema.optional(),
    // Tracks on the way from in-flight provider jobs that have not shown up as
    // queue slots yet (buffer top-ups, Dislike rerolls, Change Vibe fills) —
    // the band's honest generating count. In TRACKS, never provider calls.
    generatingTracksAhead: z.number().int().nonnegative(),
    // The part of that count whose requests carry the session's live style
    // revision or newer. A session that never changed vibe reports all of it
    // here — only a player that knows a vibe change happened may read this as
    // "the new vibe is on its way".
    generatingNewVibeTracksAhead: z.number().int().nonnegative(),
    // The in-flight generation while NO playable track exists yet;
    // null the moment one does, and null for failed/blocked jobs (the
    // generation-status banner owns those).
    pendingGeneration: pendingGenerationSchema.nullable(),
    // The current vibe facets for the Change Vibe overlay's preselection; null
    // while the session has no Style Snapshot yet.
    vibe: sessionVibeSchema.nullable(),
    // True while a switch-now vibe change is armed (a new-vibe track is being
    // generated to cut over to); the player narrates it and triggers the early
    // advance when the post-cutover queue arrives.
    switchPending: z.boolean(),
    // The Tracks one Try again buys (the provider's tracks per call), offered
    // when nothing can play. Null for a request the provider blocked for its
    // content: the same request cannot pass, so only Change Vibe helps.
    tryAgainTracks: z.number().int().positive().nullable(),
  }),
);
export type GetSessionQueueResponse = z.infer<typeof getSessionQueueResponseSchema>;

// --- 6. reportPlaybackState --------------------------------------------------

export const reportPlaybackStateRequestSchema = z.strictObject({
  sessionId: uuidSchema,
  clientId: clientIdSchema,
  /**
   * A client-minted idempotency key for THIS logical playback event. A retry of the
   * same report reuses the same id so the server dedupes persisted events
   * (started/ended/skipped/failed) — making the endpoint genuinely retryable +
   * idempotent. `position` pings carry one too but never persist, so it is ignored
   * for them. Mint a fresh id per distinct event, not per HTTP attempt.
   */
  clientEventId: uuidSchema,
  type: z.enum(PLAYBACK_REPORT_TYPES),
  queueItemId: uuidSchema.nullable(),
  trackId: uuidSchema.nullable(),
  positionSeconds: z.number().nonnegative().nullable(),
  clientTimestamp: isoDatetimeSchema,
  /**
   * True on a `started` reached by wrapping past the end of the Queue projection
   * (the loop restarting). The server widens the switch-now set-aside flag-clear
   * to the whole session on it: a completed loop walked past every set-aside,
   * including ones no later `started` position could ever reach.
   */
  queueWrapped: z.boolean().optional(),
  /**
   * True on a `started` chosen by Shuffle traversal (not a direct Queue tap). The
   * server then leaves earlier `queued` slots `queued`: Shuffle has not reached
   * them yet, so they were never skipped.
   */
  shuffled: z.boolean().optional(),
});
export type ReportPlaybackStateRequest = z.infer<typeof reportPlaybackStateRequestSchema>;

export const reportPlaybackStateResponseSchema = apiResponse(
  z.strictObject({
    accepted: z.literal(true),
    /** True only for started/ended/skipped/failed; a `position` ping persists no row. */
    persistedEvent: z.boolean(),
    /**
     * True only for a fresh started/ended/skipped report (buffer top-up); false for
     * `position`, `failed`, and deduped retries (a retried event enqueues nothing new).
     */
    bufferEnqueued: z.boolean(),
    /** Latest report wins: the reporting client is now the active controller. */
    activePlaybackClientId: clientIdSchema,
  }),
);
export type ReportPlaybackStateResponse = z.infer<typeof reportPlaybackStateResponseSchema>;

// --- 7. saveTrack ------------------------------------------------------------

export const saveTrackRequestSchema = z.strictObject({
  trackId: uuidSchema,
  /**
   * Retention is playlist membership: "save" means choosing at least one
   * Playlist, which goes through `applyTrackMemberships` — so this endpoint
   * only accepts the UNSAVE direction (remove the track from every playlist,
   * back to Ephemeral, cascading out of Favorites).
   */
  saved: z.literal(false),
});
export type SaveTrackRequest = z.infer<typeof saveTrackRequestSchema>;

export const saveTrackResponseSchema = apiResponse(trackFlagsSchema);
export type SaveTrackResponse = z.infer<typeof saveTrackResponseSchema>;

// --- 8. favoriteTrack --------------------------------------------------------

export const favoriteTrackRequestSchema = z.strictObject({
  trackId: uuidSchema,
  /** Favorite (true) implies Save; unfavorite (false) does NOT unsave. */
  favorited: z.boolean(),
});
export type FavoriteTrackRequest = z.infer<typeof favoriteTrackRequestSchema>;

export const favoriteTrackResponseSchema = apiResponse(trackFlagsSchema);
export type FavoriteTrackResponse = z.infer<typeof favoriteTrackResponseSchema>;

// --- 9. dislikeTrack (reroll/reject; one-way, no un-dislike) ------------------

export const dislikeTrackRequestSchema = z.strictObject({ trackId: uuidSchema });
export type DislikeTrackRequest = z.infer<typeof dislikeTrackRequestSchema>;

export const dislikeTrackResponseSchema = apiResponse(
  z.strictObject({
    trackId: uuidSchema,
    dislikedAt: isoDatetimeSchema,
    /** A reroll was queued (same prompt, no steering). */
    rerollQueued: z.boolean(),
    /** Reroll served a pre-paid sibling, spent a fresh call, or nothing was queued. */
    replacementSource: z.enum(['sibling', 'generation', 'none']),
  }),
);
export type DislikeTrackResponse = z.infer<typeof dislikeTrackResponseSchema>;

// --- 10. deleteTrack (explicit owner purge; never feedback) ------------------

export const deleteTrackRequestSchema = z.strictObject({ trackId: uuidSchema });
export type DeleteTrackRequest = z.infer<typeof deleteTrackRequestSchema>;

export const deleteTrackResponseSchema = apiResponse(
  z.strictObject({ trackId: uuidSchema, deleted: z.literal(true) }),
);
export type DeleteTrackResponse = z.infer<typeof deleteTrackResponseSchema>;

// --- renameTrack (Given Name; never affects Sibling Tracks) --------------------

export const renameTrackRequestSchema = z.strictObject({
  trackId: uuidSchema,
  title: z.string().trim().min(1).max(MAX_TRACK_TITLE_LENGTH),
});
export type RenameTrackRequest = z.infer<typeof renameTrackRequestSchema>;

export const renameTrackResponseSchema = apiResponse(
  z.strictObject({ trackId: uuidSchema, title: z.string() }),
);
export type RenameTrackResponse = z.infer<typeof renameTrackResponseSchema>;

// --- 11. sendFeedback (general audit write; NO `like`) -----------------------

export const sendFeedbackRequestSchema = z.strictObject({
  trackId: uuidSchema,
  sessionId: uuidSchema.nullable(),
  type: z.enum(FEEDBACK_TYPES),
  /**
   * AUDIT-ONLY. `value`/`freeformText` are stored on the `feedback_events` audit
   * trail and MUST NOT feed generation or steering — there are no detailed
   * feedback chips and no negative fingerprint. Only Change Vibe steers; Dislike
   * rerolls without steering. Kept for the audit record; never read by the
   * buffer/generation path.
   */
  value: z.string().max(200).nullable(),
  freeformText: z.string().max(2000).nullable(),
});
export type SendFeedbackRequest = z.infer<typeof sendFeedbackRequestSchema>;

export const sendFeedbackResponseSchema = apiResponse(
  z.strictObject({ recorded: z.literal(true), feedbackEventId: uuidSchema }),
);
export type SendFeedbackResponse = z.infer<typeof sendFeedbackResponseSchema>;

// --- 12. getLibrary ----------------------------------------------------------

export const LIBRARY_VIEWS = ['saved', 'favorites', 'history'] as const;
export type LibraryView = (typeof LIBRARY_VIEWS)[number];

// A GET contract: inputs may arrive as query-string params (strings / omitted),
// so `cursor` is nullish (omitted = first page) and `limit` is coerced + defaulted.
export const getLibraryRequestSchema = z.strictObject({
  view: z.enum(LIBRARY_VIEWS),
  cursor: z.string().max(500).nullish(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  /**
   * Case-insensitive substring over the shared track match surface: title,
   * genre tags, mood, activity, prompt, and origin Session title (one match
   * vocabulary with /api/search).
   */
  search: z.string().max(200).nullish(),
});
export type GetLibraryRequest = z.infer<typeof getLibraryRequestSchema>;

export const getLibraryResponseSchema = apiResponse(
  z.strictObject({
    view: z.enum(LIBRARY_VIEWS),
    items: z.array(libraryTrackItemSchema),
    nextCursor: z.string().max(500).nullable(),
  }),
);
export type GetLibraryResponse = z.infer<typeof getLibraryResponseSchema>;

// --- 13. playlists (retention-is-membership) ----------------------------------
// A Playlist is the non-generative Playback source: hand-curated, user-ordered,
// no duplicates (a track appears at most once per playlist). Favorites is the
// per-owner system playlist behind the star (fixed name, undeletable,
// unrenamable). Membership IS retention: adding saves, leaving the last
// playlist unsaves.

export const PLAYLIST_KINDS = ['user', 'favorites'] as const;
export type PlaylistKind = (typeof PLAYLIST_KINDS)[number];

/**
 * Whether the owner made and named this Playlist. Favorites is the system
 * playlist behind the star — fixed name, undeletable — so every surface that
 * offers renaming or deleting asks this first.
 */
export function isOwnerNamedPlaylist(kind: PlaylistKind): boolean {
  return kind !== 'favorites';
}

/**
 * A Playlist the owner hand-curates — what the Playlists tab lists and the save
 * picker offers. Favorites belongs to the star, and a collection carrying
 * `listedInPlaylists: false` is reached from its own Library surface, so
 * neither is curated through a general playlist surface.
 */
export function isCuratedPlaylist(playlist: {
  kind: PlaylistKind;
  listedInPlaylists: boolean;
}): boolean {
  return playlist.kind === 'user' && playlist.listedInPlaylists;
}

/** The sharing owner, as the visitor's read-only surfaces attribute them. */
export const loungePlaylistOwnerSchema = z.strictObject({
  name: z.string(),
  artistName: z.string().nullable(),
  imageUrl: z.string().nullable(),
});
export type LoungePlaylistOwner = z.infer<typeof loungePlaylistOwnerSchema>;

export const playlistSummarySchema = z.strictObject({
  id: uuidSchema,
  name: z.string(),
  kind: z.enum(PLAYLIST_KINDS),
  /** False for collections reached from their own Library surface instead of the Playlists tab. */
  listedInPlaylists: z.boolean(),
  trackCount: z.number().int().nonnegative(),
  /** Total member playtime in seconds (unknown durations count 0) — the header
   * fact, server-derived so a partially loaded member list cannot understate it. */
  totalDurationSeconds: z.number().int().nonnegative(),
  /** Members the Playlist zip can carry — the owner's own Tracks with a stored
   * local final (never a Shared reference or a stream-only member). The
   * download menu rows gate on it: `trackCount` alone would offer a zip with
   * nothing in it. */
  downloadableTrackCount: z.number().int().nonnegative(),
  /** The custom cover (upload/generation); null = derived mosaic. */
  coverImageId: uuidSchema.nullable(),
  /** Up to 4 distinct member cover ids in playlist order — the mosaic sources (always the fallback). */
  mosaicCoverImageIds: z.array(uuidSchema).max(4),
  /** Members whose ONLY playlist is this one — they leave the Library if it is deleted (the confirm copy). */
  soleMemberTrackCount: z.number().int().nonnegative(),
  /** The sole members that delete removes for good: their Session is gone, so no History holds them. */
  soleMemberDeletedTrackCount: z.number().int().nonnegative(),
  /** Whether the `trackId` passed to listPlaylists is a member; null when none was passed. */
  containsTrack: z.boolean().nullable(),
  /** The Lounge share state: null = Private, set = In Lounge —
   * every owner surface marks a set value (the consent cue). */
  sharedAt: isoDatetimeSchema.nullable(),
  /** The owner's Library pin: set = first in their Playlists
   * tab, newest pin first. Only the owner's list and detail reads carry it. */
  pinnedAt: isoDatetimeSchema.nullable(),
  createdAt: isoDatetimeSchema,
  updatedAt: isoDatetimeSchema,
});
export type PlaylistSummaryItem = z.infer<typeof playlistSummarySchema>;

/** The list endpoint's page-size ceiling. Full-list loads (the membership
 * pickers) page serially, so they ask for exactly this to minimize round trips. */
export const MAX_PLAYLISTS_LIST_PAGE_LIMIT = 100;

/** The Playlists tab's page size — one name for the schema default and the
 * Library page's server-rendered first page, so the two cannot drift. */
export const DEFAULT_PLAYLISTS_LIST_PAGE_LIMIT = 29;

export const listPlaylistsRequestSchema = z.strictObject({
  /** When present (the picker read), each summary reports `containsTrack`. */
  trackId: uuidSchema.nullish(),
  /**
   * Case-insensitive substring over the playlist name and its member track
   * titles (one match vocabulary with /api/search).
   */
  search: z.string().max(200).nullish(),
  /** Keyset paging over user playlists (Favorites and the Library pins always
   * ride the first page, outside `limit`). */
  cursor: z.string().max(500).nullish(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_PLAYLISTS_LIST_PAGE_LIMIT)
    .default(DEFAULT_PLAYLISTS_LIST_PAGE_LIMIT),
});
export type ListPlaylistsRequest = z.infer<typeof listPlaylistsRequestSchema>;

export const listPlaylistsResponseSchema = apiResponse(
  z.strictObject({
    playlists: z.array(playlistSummarySchema),
    nextCursor: z.string().max(500).nullable(),
  }),
);
export type ListPlaylistsResponse = z.infer<typeof listPlaylistsResponseSchema>;

export const createPlaylistRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(MAX_PLAYLIST_NAME_LENGTH),
});
export type CreatePlaylistRequest = z.infer<typeof createPlaylistRequestSchema>;

export const createPlaylistResponseSchema = apiResponse(
  z.strictObject({ playlist: playlistSummarySchema }),
);
export type CreatePlaylistResponse = z.infer<typeof createPlaylistResponseSchema>;

export const renamePlaylistRequestSchema = z.strictObject({
  playlistId: uuidSchema,
  name: z.string().trim().min(1).max(MAX_PLAYLIST_NAME_LENGTH),
});
export type RenamePlaylistRequest = z.infer<typeof renamePlaylistRequestSchema>;

export const renamePlaylistResponseSchema = apiResponse(
  z.strictObject({ playlistId: uuidSchema, name: z.string() }),
);
export type RenamePlaylistResponse = z.infer<typeof renamePlaylistResponseSchema>;

/** The most Users one share audience may name. */
export const MAX_SHARE_AUDIENCE_USERS = 500;

/** Who an In-Lounge playlist reaches: `everyone` is every
 * signed-in User on the Instance, including Users who join later; `selected`
 * is exactly the picked Users — never the owner, who always sees their own. */
export const shareAudienceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('everyone') }),
  z.strictObject({
    kind: z.literal('selected'),
    userIds: z.array(z.string().min(1).max(255)).min(1).max(MAX_SHARE_AUDIENCE_USERS),
  }),
]);
export type ShareAudience = z.infer<typeof shareAudienceSchema>;

/** The Lounge share write: a non-null `audience` places the
 * playlist In Lounge for that audience (or changes who it reaches), null
 * returns it to Private. Curated user playlists only. */
export const sharePlaylistRequestSchema = z.strictObject({
  playlistId: uuidSchema,
  audience: shareAudienceSchema.nullable(),
});
export type SharePlaylistRequest = z.infer<typeof sharePlaylistRequestSchema>;

export const sharePlaylistResponseSchema = apiResponse(
  z.strictObject({
    playlistId: uuidSchema,
    sharedAt: isoDatetimeSchema.nullable(),
    /** Null iff Private. */
    audience: shareAudienceSchema.nullable(),
  }),
);
export type SharePlaylistResponse = z.infer<typeof sharePlaylistResponseSchema>;

/** `GET /api/playlists/share?playlistId=` — the share picker's read. */
export const getPlaylistShareRequestSchema = z.strictObject({ playlistId: uuidSchema });
export type GetPlaylistShareRequest = z.infer<typeof getPlaylistShareRequestSchema>;

/** A User the owner may pick for a `selected` audience — every other User on
 * the Instance, attributed with the same owner vocabulary the Lounge uses. */
export const shareCandidateSchema = loungePlaylistOwnerSchema.extend({ userId: z.string() });
export type ShareCandidate = z.infer<typeof shareCandidateSchema>;

export const getPlaylistShareResponseSchema = apiResponse(
  z.strictObject({
    playlistId: uuidSchema,
    /** The current audience; null iff Private. */
    audience: shareAudienceSchema.nullable(),
    /** Every User other than the owner, display-name ordered. */
    candidates: z.array(shareCandidateSchema),
  }),
);
export type GetPlaylistShareResponse = z.infer<typeof getPlaylistShareResponseSchema>;

// The shared match vocabulary, declared ahead of BOTH surfaces
// that speak it: the Lounge box below and /search further down.

/** The one field a result's match-context line names (the rank's winner).
 * `owner` is the Lounge's addition: the sharing owner's artist or User name. */
export const SEARCH_MATCH_FIELDS = [
  'name',
  'tags',
  'prompt',
  'session',
  'tracks',
  'lyrics',
  'owner',
] as const;
export type SearchMatchField = (typeof SEARCH_MATCH_FIELDS)[number];

export const MAX_SEARCH_QUERY_LENGTH = 200;

/** Why a row is in the results: the winning field and a bounded snippet of it. */
export const searchMatchContextSchema = z.strictObject({
  field: z.enum(SEARCH_MATCH_FIELDS),
  /** Windowed around the first hit server-side; the client highlights the query inside it. */
  snippet: z.string(),
});
export type SearchMatchContext = z.infer<typeof searchMatchContextSchema>;

/** The Lounge grid's page size — divisible by every column band (2 / 3 / 4). */
export const DEFAULT_LOUNGE_PAGE_LIMIT = 24;
export const MAX_LOUNGE_PAGE_LIMIT = 100;

/** One Lounge entry: a non-empty playlist in the viewer's
 * Lounge — shared with everyone, or with the viewer by name — attributed.
 * `yours` (the inline badge) and `pinned` are per-viewer presentation. */
export const loungePlaylistItemSchema = z.strictObject({
  id: uuidSchema,
  name: z.string(),
  trackCount: z.number().int().nonnegative(),
  totalDurationSeconds: z.number().int().nonnegative(),
  coverImageId: uuidSchema.nullable(),
  mosaicCoverImageIds: z.array(uuidSchema).max(4),
  /** The share instant — the newest-first sort key. */
  sharedAt: isoDatetimeSchema,
  yours: z.boolean(),
  /** Whether the VIEWER pinned this playlist — own shares
   * included. A pinned entry lists first in the viewer's Lounge. */
  pinned: z.boolean(),
  /** The owner's User name; display falls back to its first word when no artist name is set. */
  ownerName: z.string(),
  ownerArtistName: z.string().nullable(),
  ownerImageUrl: z.string().nullable(),
  /** Present iff the listing was narrowed by a query — the row's named reason. */
  matchContext: searchMatchContextSchema.nullable(),
});
export type LoungePlaylistItem = z.infer<typeof loungePlaylistItemSchema>;

export const listLoungeRequestSchema = z.strictObject({
  cursor: z.string().max(500).nullish(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_LOUNGE_PAGE_LIMIT)
    .default(DEFAULT_LOUNGE_PAGE_LIMIT),
  /** Narrows the newest-first list — filter semantics, never a re-rank. */
  query: z.string().trim().max(MAX_SEARCH_QUERY_LENGTH).nullish(),
  /** A sharing member's user id (NOT a uuid — Better Auth mints its own format). */
  owner: z.string().trim().min(1).max(128).nullish(),
});
export type ListLoungeRequest = z.infer<typeof listLoungeRequestSchema>;

export const listLoungeResponseSchema = apiResponse(
  z.strictObject({
    playlists: z.array(loungePlaylistItemSchema),
    nextCursor: z.string().max(500).nullable(),
  }),
);
export type ListLoungeResponse = z.infer<typeof listLoungeResponseSchema>;

export const deletePlaylistRequestSchema = z.strictObject({ playlistId: uuidSchema });
export type DeletePlaylistRequest = z.infer<typeof deletePlaylistRequestSchema>;

export const deletePlaylistResponseSchema = apiResponse(
  z.strictObject({ playlistId: uuidSchema, deleted: z.literal(true) }),
);
export type DeletePlaylistResponse = z.infer<typeof deletePlaylistResponseSchema>;

export const markPlaylistPlayedRequestSchema = z.strictObject({ playlistId: uuidSchema });
export type MarkPlaylistPlayedRequest = z.infer<typeof markPlaylistPlayedRequestSchema>;

export const markPlaylistPlayedResponseSchema = apiResponse(
  z.strictObject({ playlistId: uuidSchema }),
);
export type MarkPlaylistPlayedResponse = z.infer<typeof markPlaylistPlayedResponseSchema>;

/** A playlist member: the track summary plus its 0-based slot in the user
 * order. `owner` is set only on a Shared reference — a foreign
 * track filed into the reader's playlist, always attributed. */
export const playlistMemberItemSchema = trackSummarySchema.extend({
  position: z.number().int().nonnegative(),
  originSessionTitle: z.string().max(MAX_SESSION_TITLE_LENGTH).nullable(),
  owner: loungePlaylistOwnerSchema.nullable(),
});
export type PlaylistMemberItem = z.infer<typeof playlistMemberItemSchema>;

/** The detail endpoint's page-size ceiling. Full-membership loads page serially
 * (each cursor comes from the previous page), so callers that need every member
 * ask for exactly this to minimize round trips. */
export const MAX_PLAYLIST_PAGE_LIMIT = 500;

export const getPlaylistRequestSchema = z.strictObject({
  playlistId: uuidSchema,
  cursor: z.string().max(100).nullish(),
  limit: z.coerce.number().int().positive().max(MAX_PLAYLIST_PAGE_LIMIT).default(200),
});
export type GetPlaylistRequest = z.infer<typeof getPlaylistRequestSchema>;

export const getPlaylistResponseSchema = apiResponse(
  z.strictObject({
    playlist: playlistSummarySchema,
    items: z.array(playlistMemberItemSchema),
    nextCursor: z.string().max(100).nullable(),
  }),
);
export type GetPlaylistResponse = z.infer<typeof getPlaylistResponseSchema>;

/** The visitor's read of one In-Lounge playlist: the owner detail's
 * page shape plus attribution. Same request shape (`getPlaylistRequestSchema`);
 * unknown, private, and revoked ids answer the uniform 404. */
export const getLoungePlaylistResponseSchema = apiResponse(
  z.strictObject({
    playlist: playlistSummarySchema,
    owner: loungePlaylistOwnerSchema,
    /** Whether the viewer pinned this playlist (the detail's Pin toggle). */
    pinned: z.boolean(),
    items: z.array(playlistMemberItemSchema),
    nextCursor: z.string().max(100).nullable(),
  }),
);
export type GetLoungePlaylistResponse = z.infer<typeof getLoungePlaylistResponseSchema>;

/** Both playlist pin toggles, idempotent, refusing with the
 * uniform 404. `POST /api/lounge/pin` puts a playlist in the caller's Lounge
 * first in that Lounge (Private or unknown ids refuse); `POST /api/playlists/pin`
 * puts an own playlist first in the caller's Playlists tab (another owner's or
 * unknown ids refuse). The two orders never affect each other. */
export const pinPlaylistRequestSchema = z.strictObject({
  playlistId: uuidSchema,
  pinned: z.boolean(),
});
export type PinPlaylistRequest = z.infer<typeof pinPlaylistRequestSchema>;

export const pinPlaylistResponseSchema = apiResponse(
  z.strictObject({ playlistId: uuidSchema, pinned: z.boolean() }),
);
export type PinPlaylistResponse = z.infer<typeof pinPlaylistResponseSchema>;

/** Admin moderation: return any In-Lounge playlist to Private —
 * the single cross-owner write, riding the owner's unshare purge. */
export const moderateLoungePlaylistRequestSchema = z.strictObject({
  playlistId: uuidSchema,
});
export type ModerateLoungePlaylistRequest = z.infer<typeof moderateLoungePlaylistRequestSchema>;

export const moderateLoungePlaylistResponseSchema = apiResponse(
  z.strictObject({ playlistId: uuidSchema }),
);
export type ModerateLoungePlaylistResponse = z.infer<typeof moderateLoungePlaylistResponseSchema>;

export const addPlaylistTracksRequestSchema = z.strictObject({
  playlistId: uuidSchema,
  trackIds: z.array(uuidSchema).min(1).max(100),
});
export type AddPlaylistTracksRequest = z.infer<typeof addPlaylistTracksRequestSchema>;

export const addPlaylistTracksResponseSchema = apiResponse(
  z.strictObject({
    playlistId: uuidSchema,
    /** Newly appended (request order). Existing members are neither here nor refused. */
    added: z.array(uuidSchema),
    /** Not added: absent, not owned, or rejected/deleted. */
    refused: z.array(uuidSchema),
  }),
);
export type AddPlaylistTracksResponse = z.infer<typeof addPlaylistTracksResponseSchema>;

export const removePlaylistTrackRequestSchema = z.strictObject({
  playlistId: uuidSchema,
  trackId: uuidSchema,
});
export type RemovePlaylistTrackRequest = z.infer<typeof removePlaylistTrackRequestSchema>;

export const removePlaylistTrackResponseSchema = apiResponse(
  z.strictObject({
    playlistId: uuidSchema,
    trackId: uuidSchema,
    /** False = the track was not a member (a no-op, not an error). */
    removed: z.boolean(),
    /** True when this was the track's LAST playlist — it left the Library
     *  (Ephemeral). Drives the removal notice. */
    unsaved: z.boolean(),
    /** True when the track left the Library with its Session already gone:
     *  no History holds it, so it was deleted for good. */
    deletedForGood: z.boolean(),
  }),
);
export type RemovePlaylistTrackResponse = z.infer<typeof removePlaylistTrackResponseSchema>;

/** The longest membership one order write carries. A playlist past it is beyond
 *  hand-reordering anyway, so the menu row goes dark rather than the commit
 *  failing at the schema. */
export const MAX_PLAYLIST_ORDER_TRACKS = 500;

export const setPlaylistOrderRequestSchema = z.strictObject({
  playlistId: uuidSchema,
  /** The playlist's FULL membership in the owner's new order — the reorder mode
   *  commits once, so a half-applied order is not reachable. */
  trackIds: z.array(uuidSchema).max(MAX_PLAYLIST_ORDER_TRACKS),
});
export type SetPlaylistOrderRequest = z.infer<typeof setPlaylistOrderRequestSchema>;

export const setPlaylistOrderResponseSchema = apiResponse(
  z.strictObject({ playlistId: uuidSchema, trackIds: z.array(uuidSchema) }),
);
export type SetPlaylistOrderResponse = z.infer<typeof setPlaylistOrderResponseSchema>;

export const applyTrackMembershipsRequestSchema = z.strictObject({
  trackId: uuidSchema,
  /** The track's FULL desired membership (the picker's checked set). */
  playlistIds: z.array(uuidSchema).max(100),
  /** Inline "New playlist" that also receives the track, in the same commit. */
  createPlaylistName: z.string().trim().min(1).max(MAX_PLAYLIST_NAME_LENGTH).nullish(),
});
export type ApplyTrackMembershipsRequest = z.infer<typeof applyTrackMembershipsRequestSchema>;

export const applyTrackMembershipsResponseSchema = apiResponse(
  z.strictObject({
    trackId: uuidSchema,
    /** The resulting membership, including any inline-created playlist. */
    playlistIds: z.array(uuidSchema),
    createdPlaylistId: uuidSchema.nullable(),
    flags: trackFlagsSchema,
    /** `trackSummarySchema.inCuratedPlaylist` after the commit — the surface that
     *  opened the picker syncs its Add to Playlist control from it. */
    inCuratedPlaylist: z.boolean(),
  }),
);
export type ApplyTrackMembershipsResponse = z.infer<typeof applyTrackMembershipsResponseSchema>;

// --- getTrack (single owned-track detail) ------------------------------------
// A small owner-scoped read for one track's summary (flags + app-routed audio).
// NOT one of the 16 registry contracts — the library/queue already embed track
// summaries — so it is a standalone schema the `/api/tracks/[trackId]` route and the
// api-client validate against, without widening `API_CONTRACTS`. Audio is ALWAYS an
// app-route path, enforced by `trackSummarySchema`.

export const getTrackResponseSchema = apiResponse(trackSummarySchema);
export type GetTrackResponse = z.infer<typeof getTrackResponseSchema>;

// --- getTrackLyrics (owned-track lyrics view) ---------------------------------
// Like getTrack, a standalone owner-scoped read (not a registry contract). The
// server builds display lines with `buildLyricLines`; the client only renders.
// Lyric text is fetched on demand — it never rides the queue poll.

/** One display row of a Track's lyrics (structurally `LyricLine`). */
export const lyricLineSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('section'), label: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('line'),
    text: z.string().min(1),
    /** Seek target in seconds; null on unsynced lyrics. */
    timeSeconds: z.number().nonnegative().nullable(),
  }),
]);

export const trackLyricsSchema = z.strictObject({
  /** `instrumental` → no lyrics surface; `pending` → vocal but the words are not
   *  written yet (poll again); `ready` → final (empty `lines` = nothing kept). */
  state: z.enum(['instrumental', 'pending', 'ready']),
  lines: z.array(lyricLineSchema),
  /** True when the lines carry times for follow-the-playhead + tap-to-seek. */
  synced: z.boolean(),
  /** True when this answer will never improve on its own. False while the
   *  track's job is still producing the words or their timing — poll again. */
  settled: z.boolean(),
});
export const getTrackLyricsResponseSchema = apiResponse(trackLyricsSchema);
export type TrackLyrics = z.infer<typeof trackLyricsSchema>;

// --- getTrackDetails (owned-track descriptive data) ---------------------------
// Like getTrackLyrics, a standalone owner-scoped read (not a registry contract)
// fetched when the Track Data sheet opens — the queue payload stays slim. This
// is the ONE place the style/expanded prompt reaches the client; it never rides
// the queue/`sessionVibe` contract. Never includes: encrypted source URLs,
// seeds/`seedParameters`, `lyricContext`, or raw provider payloads.

/** Everything descriptive Liedmotif knows about one Track (nullable = absent —
 *  the client renders nothing for it, never an empty label). */
export const trackDetailsSchema = z.strictObject({
  title: z.string().nullable(),
  /** The owning Session's title (the Track's album). */
  sessionTitle: z.string().nullable(),
  /** Resolved like the MP3 embed: profile Artist Name, else the User name. */
  artistName: z.string(),
  createdAt: isoDatetimeSchema,
  durationSeconds: z.number().nonnegative().nullable(),
  /** The Session's user prompt — what the listener asked for. */
  userPrompt: z.string().nullable(),
  /** What the music model actually received (`generation_requests.stylePrompt`). */
  stylePrompt: z.string().nullable(),
  /** The text LLM's expansion; null on the structured/no-LLM path. */
  expandedPrompt: z.string().nullable(),
  genreTags: z.array(z.string().min(1)),
  activity: z.string().nullable(),
  mood: z.string().nullable(),
  energy: z.string().nullable(),
  vocalMode: z.enum(VOCAL_MODES),
  /** The request's Style Snapshot language (vocal sessions); null otherwise. */
  language: z.string().nullable(),
  /** Rounded measured tempo; null until the analysis lands. */
  bpm: z.number().positive().nullable(),
  providerKey: z.string(),
  providerModel: z.string().nullable(),
  licenseNote: z.string().nullable(),
});
export const getTrackDetailsResponseSchema = apiResponse(trackDetailsSchema);
export type TrackDetails = z.infer<typeof trackDetailsSchema>;

// --- listSessions — My Sessions ----------------------------------------------
// SESSION-centric, NOT track-centric: the list of resumable **Stopped** sessions
// ("return to that experience" via Resume), deliberately DISTINCT from the
// track-centric getLibrary ("play or keep this song"). Different objects at
// different granularity — there is no library `view` facet here and a
// session item carries no audio/track flags.

// A resumable Stopped session as the My Sessions list renders it. `lastActiveAt` is
// the server-derived most-recent-active instant (the My Sessions sort key), always
// present; Track activity is a compact Session-level projection, not a Track
// summary. Genre ids come from the playable Tracks held by the Session rather than
// its mutable Style Snapshot.
export const sessionTrackActivitySchema = z.strictObject({
  trackCount: z.number().int().nonnegative(),
  /** A Track of unknown length counts 0, as in a Playlist. */
  totalDurationSeconds: z.number().nonnegative(),
  genreTags: z.array(z.string().min(1)).max(3),
});
export type SessionTrackActivity = z.infer<typeof sessionTrackActivitySchema>;
export const EMPTY_SESSION_TRACK_ACTIVITY: SessionTrackActivity = {
  trackCount: 0,
  totalDurationSeconds: 0,
  genreTags: [],
};

export const sessionListItemSchema = z.strictObject({
  id: uuidSchema,
  title: z.string().nullable(),
  coverImageId: uuidSchema.nullable(),
  lastActiveAt: isoDatetimeSchema,
  status: z.enum(ACTIVITY_SESSION_STATUSES),
  pinned: z.boolean(),
  ...sessionTrackActivitySchema.shape,
});
export type SessionListItem = z.infer<typeof sessionListItemSchema>;

export const activeSessionOverviewSchema = sessionSummarySchema.extend({
  ...sessionTrackActivitySchema.shape,
});
export type ActiveSessionOverview = z.infer<typeof activeSessionOverviewSchema>;

// A GET contract: inputs may arrive as query-string params. Paging mirrors
// getLibrary (cursor nullish = first page; limit coerced + defaulted) but carries NO
// `view` — My Sessions is a single list, not a faceted library.
export const listSessionsRequestSchema = z.strictObject({
  cursor: z.string().max(500).nullish(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  includeActive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  // Split pinned Sessions out of `items` into `pinned`.
  includePinned: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});
export type ListSessionsRequest = z.infer<typeof listSessionsRequestSchema>;

export const listSessionsResponseSchema = apiResponse(
  z.strictObject({
    items: z.array(sessionListItemSchema),
    nextCursor: z.string().max(500).nullable(),
    activeSession: activeSessionOverviewSchema.nullable(),
    // The owner's pinned Stopped Sessions, newest pin first; empty unless the
    // request asked for them, in which case `items` leaves them out.
    pinned: z.array(sessionListItemSchema).max(MAX_PINNED_SESSIONS),
  }),
);
export type ListSessionsResponse = z.infer<typeof listSessionsResponseSchema>;

// --- search (ranked, capped retrieval over one match vocabulary) --------------
// The one surface that crosses the Library / My Sessions boundary: a typed
// query matched against Sessions, Tracks and Playlists at once, ranked by
// match quality and CAPPED rather than paged — exact per-group counts, no
// cursors. Lyrics mode is exclusive: Tracks only, sung lyric text only.

export const SEARCH_SCOPES = ['all', 'sessions', 'tracks', 'playlists'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export const SEARCH_SORTS = ['relevance', 'newest', 'title'] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

/** Rows per group under the All scope; a scoped tab uses the scoped cap. */
export const SEARCH_ALL_GROUP_LIMIT = 5;
export const SEARCH_SCOPED_GROUP_LIMIT = 50;

export const searchTrackItemSchema = libraryTrackItemSchema.extend({
  matchContext: searchMatchContextSchema,
});
export type SearchTrackItem = z.infer<typeof searchTrackItemSchema>;

export const searchSessionItemSchema = sessionListItemSchema.extend({
  matchContext: searchMatchContextSchema,
});
export type SearchSessionItem = z.infer<typeof searchSessionItemSchema>;

export const searchPlaylistItemSchema = playlistSummarySchema.extend({
  matchContext: searchMatchContextSchema,
  /** How many member track titles matched — the "N matches" meta line. */
  memberMatchCount: z.number().int().nonnegative(),
  /** Set only on a Lounge-pinned foreign playlist: the sharing owner's
   * attribution, so a foreign row is always visibly foreign. Null on the reader's own. */
  owner: loungePlaylistOwnerSchema.nullable(),
});
export type SearchPlaylistItem = z.infer<typeof searchPlaylistItemSchema>;

function searchGroupSchema<T extends z.ZodType>(itemSchema: T) {
  return z.strictObject({
    items: z.array(itemSchema),
    /** Exact count of ALL matches, independent of the cap. */
    matchCount: z.number().int().nonnegative(),
    /** True when the cap held rows back — the UI must say so in words. */
    truncated: z.boolean(),
  });
}

// A GET contract: `lyrics` arrives as a URL flag (`?lyrics=1`); anything but
// the listed spellings is a validation error, never a silently-off mode.
export const searchRequestSchema = z.strictObject({
  q: z.string().trim().min(2).max(MAX_SEARCH_QUERY_LENGTH),
  scope: z.enum(SEARCH_SCOPES).default('all'),
  sort: z.enum(SEARCH_SORTS).default('relevance'),
  lyrics: z
    .enum(['1', 'true', '0', 'false'])
    .default('0')
    .transform((value) => value === '1' || value === 'true'),
});
export type SearchRequest = z.infer<typeof searchRequestSchema>;

/** Groups the request did not query (a scope tab, lyrics mode) are null. */
export const searchResponseSchema = apiResponse(
  z.strictObject({
    query: z.string(),
    scope: z.enum(SEARCH_SCOPES),
    sort: z.enum(SEARCH_SORTS),
    lyrics: z.boolean(),
    sessions: searchGroupSchema(searchSessionItemSchema).nullable(),
    tracks: searchGroupSchema(searchTrackItemSchema).nullable(),
    playlists: searchGroupSchema(searchPlaylistItemSchema).nullable(),
  }),
);
export type SearchResponse = z.infer<typeof searchResponseSchema>;
export type SearchResponseData = Extract<SearchResponse, { ok: true }>['data'];

// --- 13. getDiagnostics ------------------------------------------------------

// Limits are counted internally in provider calls but ALWAYS shown in tracks.
const usageTracksSchema = z.strictObject({
  dailyTracksUsed: z.number().int().nonnegative(),
  /** `null`: the window is unbounded (the Admin with the Track ceiling off). */
  dailyTracksLimit: z.number().int().nonnegative().nullable(),
  monthlyTracksUsed: z.number().int().nonnegative(),
  monthlyTracksLimit: z.number().int().nonnegative().nullable(),
  minHeadroomTracksToStartSession: z.number().int().nonnegative(),
  /**
   * A One-time budget has one total, which fills both windows above; without
   * this a reader would show a pot that never refills as today's allowance.
   */
  budgetKind: z.enum(BUDGET_KINDS),
});

export const getDiagnosticsRequestSchema = z.strictObject({});
export type GetDiagnosticsRequest = z.infer<typeof getDiagnosticsRequestSchema>;

export const getDiagnosticsResponseSchema = apiResponse(
  z.strictObject({
    // Worker status, assembled from the DB heartbeat, the graphile jobs view,
    // and the provider-job ledger. `null` consistently means "source
    // unavailable" (worker never reported / graphile schema missing); the
    // events feed is sanitized at derivation — ids and timings only.
    worker: z.strictObject({
      heartbeatAt: isoDatetimeSchema.nullable(),
      stale: z.boolean(),
      state: z.enum(['starting', 'ready', 'degraded']).nullable(),
      concurrency: z.number().int().positive().nullable(),
      jobsInFlight: z.number().int().nonnegative().nullable(),
      queuedJobs: z.number().int().nonnegative().nullable(),
      failedJobs: z.number().int().nonnegative().nullable(),
      lastProviderPoll: z.strictObject({ status: z.string(), at: isoDatetimeSchema }).nullable(),
      retriesToday: z.number().int().nonnegative().nullable(),
      events: z.array(
        z.strictObject({
          at: isoDatetimeSchema,
          level: z.enum(['info', 'warn']),
          message: z.string(),
        }),
      ),
    }),
    providers: z.array(
      z.strictObject({
        providerType: z.enum(PROVIDER_TYPES),
        providerKey: z.string(),
        validationStatus: z.string(),
        lastValidatedAt: isoDatetimeSchema.nullable(),
      }),
    ),
    usage: usageTracksSchema,
    // The full controller-aware summary (generationStatus/sessionMode/cover/message +
    // two-value status), or null when nothing is active — so diagnostics can surface
    // the same "why generation is degraded" state the player shows.
    activeSession: sessionSummarySchema.nullable(),
  }),
);
export type GetDiagnosticsResponse = z.infer<typeof getDiagnosticsResponseSchema>;
export type GetDiagnosticsData = Extract<GetDiagnosticsResponse, { ok: true }>['data'];
export type WorkerDiagnostics = GetDiagnosticsData['worker'];

// --- 13b. getChrome ----------------------------------------------------------

export const getChromeRequestSchema = z.strictObject({});
export type GetChromeRequest = z.infer<typeof getChromeRequestSchema>;

/**
 * Exactly what the app shell's chrome consumes — the caller's usage readout and
 * their active Session. The route gates it Member-or-Admin (`requireOwnerId`);
 * the registry's `auth` field is a blanket `admin`, and the
 * guard choice at the route is the authorization boundary.
 */
export const getChromeResponseSchema = apiResponse(
  z.strictObject({
    usage: usageTracksSchema,
    activeSession: sessionSummarySchema.nullable(),
  }),
);
export type GetChromeResponse = z.infer<typeof getChromeResponseSchema>;
export type GetChromeData = Extract<GetChromeResponse, { ok: true }>['data'];

// --- 14. validateProvider ----------------------------------------------------

export const validateProviderRequestSchema = z.strictObject({
  providerType: z.enum(PROVIDER_TYPES),
  providerKey: z.string().min(1).max(100),
});
export type ValidateProviderRequest = z.infer<typeof validateProviderRequestSchema>;

export const validateProviderResponseSchema = apiResponse(
  z.strictObject({
    providerType: z.enum(PROVIDER_TYPES),
    providerKey: z.string(),
    valid: z.boolean(),
    status: z.string(),
    checkedAt: isoDatetimeSchema,
    /** A safe summary; never the raw provider error. */
    message: z.string().nullable(),
  }),
);
export type ValidateProviderResponse = z.infer<typeof validateProviderResponseSchema>;

// --- Registry ----------------------------------------------------------------

export const API_ENDPOINT_NAMES = [
  'startSession',
  'stopSession',
  'deleteSession',
  'convertSessionToPlaylist',
  'renameSession',
  'setSessionMode',
  'setSessionDuration',
  'resumeSession',
  'playSessionTrack',
  'changeVibe',
  'moreLikeThis',
  'getSessionQueue',
  'regenerateSessionCover',
  'sessionCoverStatus',
  'selectSessionCover',
  'deleteSessionCover',
  'reportPlaybackState',
  'saveTrack',
  'favoriteTrack',
  'dislikeTrack',
  'deleteTrack',
  'renameTrack',
  'sendFeedback',
  'getLibrary',
  'listPlaylists',
  'createPlaylist',
  'renamePlaylist',
  'deletePlaylist',
  'markPlaylistPlayed',
  'getPlaylist',
  'addPlaylistTracks',
  'removePlaylistTrack',
  'setPlaylistOrder',
  'applyTrackMemberships',
  'regeneratePlaylistCover',
  'playlistCoverStatus',
  'selectPlaylistCover',
  'deletePlaylistCover',
  'listSessions',
  'search',
  'getDiagnostics',
  'getChrome',
  'validateProvider',
] as const;
export type ApiEndpointName = (typeof API_ENDPOINT_NAMES)[number];

/** The endpoint contracts, with route, auth (all `admin`), and retry policy. */
export const API_CONTRACTS: Readonly<Record<ApiEndpointName, EndpointContract>> = {
  startSession: {
    method: 'POST',
    path: '/api/sessions',
    auth: 'admin',
    request: startSessionRequestSchema,
    response: startSessionResponseSchema,
    retry: {
      retryable: false,
      idempotent: false,
      note: 'Creates a session and may submit a paid provider job; the server guards money-idempotency, but the client must NOT auto-retry — surface the error.',
    },
    description:
      'Start a new session from free text or structured controls; supersedes the active session.',
  },
  stopSession: {
    method: 'POST',
    path: '/api/sessions/stop',
    auth: 'admin',
    request: stopSessionRequestSchema,
    response: stopSessionResponseSchema,
    retry: {
      retryable: true,
      idempotent: true,
      note: 'Stopping an already-stopped session is a no-op. Already-submitted provider tasks may still finish and count toward limits.',
    },
    description: 'Stop the active session (no new generation; in-flight tasks may still arrive).',
  },
  deleteSession: {
    method: 'POST',
    path: '/api/sessions/delete',
    auth: 'admin',
    request: deleteSessionRequestSchema,
    response: deleteSessionResponseSchema,
    retry: {
      retryable: false,
      idempotent: true,
      note: 'Destructive; a repeat of a completed delete answers not_found. A conflict (session still active) is not retryable automatically — surface it.',
    },
    description:
      'Permanently delete a Stopped session and reclaim its Ephemeral audio; Saved tracks and spend accounting are untouched.',
  },
  convertSessionToPlaylist: {
    method: 'POST',
    path: '/api/sessions/convert-to-playlist',
    auth: 'admin',
    request: convertSessionToPlaylistRequestSchema,
    response: convertSessionToPlaylistResponseSchema,
    retry: {
      retryable: false,
      idempotent: false,
      note: 'Every call mints a new Playlist — a blind retry can create two. Surface the error.',
    },
    description:
      "File a Session's listed Tracks into a new Playlist, making them Durable; the Session itself is left as it is.",
  },
  renameSession: {
    method: 'POST',
    path: '/api/sessions/rename',
    auth: 'admin',
    request: renameSessionRequestSchema,
    response: renameSessionResponseSchema,
    retry: {
      retryable: true,
      idempotent: true,
      note: 'Cosmetic single-column write; repeating with the same name is a no-op (the tag retag dedupes per track).',
    },
    description:
      'Replace the Session Name with a Given Name (one-way, cosmetic, never steering); downloaded tracks retag their album tag in the background.',
  },
  setSessionMode: {
    method: 'POST',
    path: '/api/sessions/mode',
    auth: 'admin',
    request: setSessionModeRequestSchema,
    response: setSessionModeResponseSchema,
    retry: {
      retryable: true,
      idempotent: true,
      note: 'Single-column policy write; re-sending the same mode is a no-op. The worker picks the new policy up on its next buffer tick.',
    },
    description:
      "Set the Session's generation policy: keep generating new Tracks, or loop the Tracks it already has.",
  },
  setSessionDuration: {
    method: 'POST',
    path: '/api/sessions/duration',
    auth: 'admin',
    request: setSessionDurationRequestSchema,
    response: setSessionDurationResponseSchema,
    retry: {
      retryable: true,
      idempotent: true,
      note: 'Sets or clears the Session target under generation admission serialization.',
    },
    description: 'Edit the Session duration target, optionally with its mode, in one write.',
  },
  resumeSession: {
    method: 'POST',
    path: '/api/sessions/resume',
    auth: 'admin',
    request: resumeSessionRequestSchema,
    response: resumeSessionResponseSchema,
    retry: {
      retryable: false,
      idempotent: false,
      note: 'Never gated by cost limits; re-activates a Stopped session in place (same identity/style/position) and stops the current active one. Do not auto-retry.',
    },
    description:
      'Resume a Stopped session under its same identity; supersedes the active session and is never cost-gated.',
  },
  playSessionTrack: {
    method: 'POST',
    path: '/api/sessions/play-track',
    auth: 'admin',
    request: playSessionTrackRequestSchema,
    response: playSessionTrackResponseSchema,
    retry: {
      retryable: false,
      idempotent: false,
      note: 'Resumes a Stopped session (superseding the active one) positioned at the track; an Active session only moves its cursor. Do not auto-retry.',
    },
    description:
      'Play one of a session’s own Tracks through the session: resume-if-stopped plus queue-cursor positioning; never cost-gated.',
  },
  changeVibe: {
    method: 'POST',
    path: '/api/sessions/change-vibe',
    auth: 'admin',
    request: changeVibeRequestSchema,
    response: changeVibeResponseSchema,
    retry: {
      retryable: false,
      idempotent: false,
      note: 'Re-styles in place (may call the text LLM to build a new Style Snapshot). Do not auto-retry.',
    },
    description:
      'Re-style the CURRENT session in place (same identity/queue/position); the only steering action.',
  },
  moreLikeThis: {
    method: 'POST',
    path: '/api/sessions/more-like-this',
    auth: 'admin',
    request: moreLikeThisRequestSchema,
    response: moreLikeThisResponseSchema,
    retry: {
      retryable: false,
      idempotent: false,
      note: 'Track-seeded Start Session; creates a new session and may submit a paid job. Do not auto-retry.',
    },
    description:
      'Start a NEW session seeded from existing track(s); supersedes the active session.',
  },
  getSessionQueue: {
    method: 'GET',
    path: '/api/sessions/queue',
    auth: 'admin',
    request: getSessionQueueRequestSchema,
    response: getSessionQueueResponseSchema,
    retry: { retryable: true, idempotent: true, note: 'Read-only; safe to poll.' },
    description:
      'Fetch the server-authoritative queue (the single source of truth for play order).',
  },
  regenerateSessionCover: {
    method: 'POST',
    path: '/api/sessions/cover/regenerate',
    auth: 'admin',
    request: regenerateSessionCoverRequestSchema,
    response: regenerateSessionCoverResponseSchema,
    retry: {
      retryable: false,
      idempotent: false,
      note: 'Reserves one possibly-paid generation attempt; a repeat while it is live returns pending instead of spending again, but the client must NOT auto-retry.',
    },
    description: 'Reserve and enqueue one user-triggered Session Cover regeneration attempt.',
  },
  sessionCoverStatus: {
    method: 'POST',
    path: '/api/sessions/cover/status',
    auth: 'admin',
    request: sessionCoverStatusRequestSchema,
    response: sessionCoverStatusResponseSchema,
    retry: { retryable: true, idempotent: true, note: 'Read-only; safe to poll.' },
    description:
      'Report the Session Cover state for the regenerate modal: current cover, in-flight work, and the latest regeneration outcome.',
  },
  selectSessionCover: {
    method: 'POST',
    path: '/api/sessions/cover/select',
    auth: 'admin',
    request: selectSessionCoverRequestSchema,
    response: selectSessionCoverResponseSchema,
    retry: {
      retryable: true,
      idempotent: true,
      note: "Zero-cost pointer swap within the session's own history; repeating it is a no-op.",
    },
    description:
      'Re-point the Session at a previously generated cover from its own history (no provider call, no limit consumption).',
  },
  deleteSessionCover: {
    method: 'POST',
    path: '/api/sessions/cover/delete',
    auth: 'admin',
    request: deleteSessionCoverRequestSchema,
    response: deleteSessionCoverResponseSchema,
    retry: {
      retryable: false,
      idempotent: true,
      note: 'Destructive within the session own history; a repeat of a completed delete answers not_found. The current cover is never deletable.',
    },
    description:
      'Delete a previously generated cover from the Session own history (bytes reclaimed via the deletion queue); spend accounting is untouched.',
  },
  reportPlaybackState: {
    method: 'POST',
    path: '/api/sessions/playback',
    auth: 'admin',
    request: reportPlaybackStateRequestSchema,
    response: reportPlaybackStateResponseSchema,
    retry: {
      retryable: true,
      idempotent: true,
      note: 'Idempotent via `clientEventId`: a retry reuses the same key so persisted events (started/ended/skipped/failed) dedupe and never double-count. Periodic `position` pings update live fields only (no row) and are safe to drop or retry.',
    },
    description: 'Report playback state; persists rows only for started/ended/skipped/failed.',
  },
  saveTrack: {
    method: 'POST',
    path: '/api/tracks/save',
    auth: 'admin',
    request: saveTrackRequestSchema,
    response: saveTrackResponseSchema,
    retry: {
      retryable: true,
      idempotent: true,
      note: 'Setting `saved` to its current value is a no-op.',
    },
    description: 'Save/unsave a track (retention floor); the flag is the source of truth.',
  },
  favoriteTrack: {
    method: 'POST',
    path: '/api/tracks/favorite',
    auth: 'admin',
    request: favoriteTrackRequestSchema,
    response: favoriteTrackResponseSchema,
    retry: {
      retryable: true,
      idempotent: true,
      note: 'Idempotent; favoriting implies saving (favoritedAt ⇒ savedAt).',
    },
    description: 'Favorite/unfavorite a track (favorite implies save).',
  },
  dislikeTrack: {
    method: 'POST',
    path: '/api/tracks/dislike',
    auth: 'admin',
    request: dislikeTrackRequestSchema,
    response: dislikeTrackResponseSchema,
    retry: {
      retryable: true,
      idempotent: true,
      note: 'Disliking an already-disliked track is a no-op; the reroll is idempotent per track and does not steer.',
    },
    description: 'Dislike = reroll the same prompt + reject the track (hidden now, deleted ~24h).',
  },
  deleteTrack: {
    method: 'POST',
    path: '/api/tracks/delete',
    auth: 'admin',
    request: deleteTrackRequestSchema,
    response: deleteTrackResponseSchema,
    retry: {
      retryable: true,
      idempotent: true,
      note: 'Deleting an already deleted or rejected owned track is a no-op success.',
    },
    description: 'Explicitly delete an owned Track and queue its audio for immediate purge.',
  },
  renameTrack: {
    method: 'POST',
    path: '/api/tracks/rename',
    auth: 'admin',
    request: renameTrackRequestSchema,
    response: renameTrackResponseSchema,
    retry: {
      retryable: true,
      idempotent: true,
      note: 'Cosmetic single-column write; repeating with the same name is a no-op (the tag retag dedupes per track).',
    },
    description:
      'Replace one Track title with a Given Name; its downloaded file retags in the background, siblings are untouched.',
  },
  sendFeedback: {
    method: 'POST',
    path: '/api/feedback',
    auth: 'admin',
    request: sendFeedbackRequestSchema,
    response: sendFeedbackResponseSchema,
    retry: {
      retryable: true,
      idempotent: false,
      note: 'Appends an audit row (a retry may append a duplicate, which is harmless). Track flags are set by the dedicated save/favorite/dislike endpoints.',
    },
    description: 'General feedback audit write (dislike/skip/save/favorite); there is NO `like`.',
  },
  getLibrary: {
    method: 'GET',
    path: '/api/library',
    auth: 'admin',
    request: getLibraryRequestSchema,
    response: getLibraryResponseSchema,
    retry: { retryable: true, idempotent: true, note: 'Read-only; safe to retry.' },
    description: 'List the track-centric library (saved / favorites / history) with cursor paging.',
  },
  listPlaylists: {
    method: 'GET',
    path: '/api/playlists',
    auth: 'admin',
    request: listPlaylistsRequestSchema,
    response: listPlaylistsResponseSchema,
    retry: { retryable: true, idempotent: true, note: 'Read-only; safe to retry.' },
    description:
      'List the owner playlists (Favorites first, then Library pins); with ?trackId=, each reports membership for the picker.',
  },
  createPlaylist: {
    method: 'POST',
    path: '/api/playlists',
    auth: 'admin',
    request: createPlaylistRequestSchema,
    response: createPlaylistResponseSchema,
    retry: {
      retryable: false,
      idempotent: false,
      note: 'Duplicate names are legal, so a blind retry can mint a second playlist — surface the error instead.',
    },
    description: 'Create an empty user playlist.',
  },
  renamePlaylist: {
    method: 'POST',
    path: '/api/playlists/rename',
    auth: 'admin',
    request: renamePlaylistRequestSchema,
    response: renamePlaylistResponseSchema,
    retry: {
      retryable: true,
      idempotent: true,
      note: 'Re-applying the same name is a no-op. The Favorites system playlist refuses (409).',
    },
    description: 'Rename a user playlist (Favorites cannot be renamed).',
  },
  deletePlaylist: {
    method: 'POST',
    path: '/api/playlists/delete',
    auth: 'admin',
    request: deletePlaylistRequestSchema,
    response: deletePlaylistResponseSchema,
    retry: {
      retryable: true,
      idempotent: true,
      note: 'Deleting an already-deleted playlist is a 404 no-op. Members with no other playlist leave the Library (Ephemeral). The Favorites system playlist refuses (409).',
    },
    description: 'Delete a user playlist; sole-membership tracks return to Ephemeral.',
  },
  markPlaylistPlayed: {
    method: 'POST',
    path: '/api/playlists/played',
    auth: 'admin',
    request: markPlaylistPlayedRequestSchema,
    response: markPlaylistPlayedResponseSchema,
    retry: {
      retryable: true,
      idempotent: true,
      note: 'A retried touch just re-stamps the same play; never worth surfacing to the user.',
    },
    description:
      'Record that playlist playback engaged — the "played last" half of the Playlists tab activity order.',
  },
  getPlaylist: {
    method: 'GET',
    path: '/api/playlists/detail',
    auth: 'admin',
    request: getPlaylistRequestSchema,
    response: getPlaylistResponseSchema,
    retry: { retryable: true, idempotent: true, note: 'Read-only; safe to retry.' },
    description: 'One playlist with its members in user order (position-keyset paging).',
  },
  addPlaylistTracks: {
    method: 'POST',
    path: '/api/playlists/tracks/add',
    auth: 'admin',
    request: addPlaylistTracksRequestSchema,
    response: addPlaylistTracksResponseSchema,
    retry: {
      retryable: true,
      idempotent: true,
      note: 'Idempotent per track (no duplicates); adding implies Save. A retry re-reports already-added tracks as neither added nor refused.',
    },
    description: 'Append tracks to a playlist (multi-select add; membership implies Save).',
  },
  removePlaylistTrack: {
    method: 'POST',
    path: '/api/playlists/tracks/remove',
    auth: 'admin',
    request: removePlaylistTrackRequestSchema,
    response: removePlaylistTrackResponseSchema,
    retry: {
      retryable: true,
      idempotent: true,
      note: 'Removing a non-member is a no-op (removed: false). Removal from the LAST playlist unsaves the track.',
    },
    description: 'Remove one track from a playlist (never unsaves while other memberships remain).',
  },
  setPlaylistOrder: {
    method: 'POST',
    path: '/api/playlists/tracks/order',
    auth: 'admin',
    request: setPlaylistOrderRequestSchema,
    response: setPlaylistOrderResponseSchema,
    retry: {
      retryable: true,
      idempotent: true,
      note: 'Re-applying the same order is a no-op. An order that is not exactly the current membership answers conflict — the client reloads rather than retries.',
    },
    description: 'Replace the playlist order with a full ordered membership.',
  },
  applyTrackMemberships: {
    method: 'POST',
    path: '/api/playlists/memberships/apply',
    auth: 'admin',
    request: applyTrackMembershipsRequestSchema,
    response: applyTrackMembershipsResponseSchema,
    retry: {
      retryable: false,
      idempotent: false,
      note: 'Idempotent for a plain desired set, but `createPlaylistName` mints a playlist per call — a blind retry can create two. Surface the error.',
    },
    description:
      'Atomically set one track full playlist membership (the save-picker commit); an empty set is Unsave.',
  },
  regeneratePlaylistCover: {
    method: 'POST',
    path: '/api/playlists/cover/regenerate',
    auth: 'admin',
    request: regeneratePlaylistCoverRequestSchema,
    response: regeneratePlaylistCoverResponseSchema,
    retry: {
      retryable: false,
      idempotent: false,
      note: 'Reserves a PAID image-generation attempt; a live attempt answers `pending` (a double-tap can never double-spend), but a blind retry must not re-reserve. Surface the error.',
    },
    description: 'Reserve one user-triggered Playlist cover generation attempt.',
  },
  playlistCoverStatus: {
    method: 'GET',
    path: '/api/playlists/cover/status',
    auth: 'admin',
    request: playlistCoverStatusRequestSchema,
    response: playlistCoverStatusResponseSchema,
    retry: {
      retryable: true,
      idempotent: true,
      note: 'Read-only; safe to retry (the modal polls it).',
    },
    description: 'Live attempt, usage budget, and re-selectable cover history for one playlist.',
  },
  selectPlaylistCover: {
    method: 'POST',
    path: '/api/playlists/cover/select',
    auth: 'admin',
    request: selectPlaylistCoverRequestSchema,
    response: selectPlaylistCoverResponseSchema,
    retry: {
      retryable: true,
      idempotent: true,
      note: 'A zero-cost pointer swap; re-applying the same cover (or null = back to the mosaic) is a no-op.',
    },
    description: 'Adopt a generated/uploaded cover from the history, or clear back to the mosaic.',
  },
  deletePlaylistCover: {
    method: 'POST',
    path: '/api/playlists/cover/delete',
    auth: 'admin',
    request: deletePlaylistCoverRequestSchema,
    response: deletePlaylistCoverResponseSchema,
    retry: {
      retryable: true,
      idempotent: true,
      note: 'Deleting an already-deleted history cover is a 404 no-op. The current cover cannot be deleted while selected.',
    },
    description: 'Delete one cover from the playlist history (frees a history slot).',
  },
  listSessions: {
    method: 'GET',
    path: '/api/sessions',
    auth: 'admin',
    request: listSessionsRequestSchema,
    response: listSessionsResponseSchema,
    retry: { retryable: true, idempotent: true, note: 'Read-only; safe to retry/poll.' },
    description:
      'List resumable Stopped sessions (My Sessions); session-centric, distinct from the track-centric library.',
  },
  search: {
    method: 'GET',
    path: '/api/search',
    auth: 'admin',
    request: searchRequestSchema,
    response: searchResponseSchema,
    retry: { retryable: true, idempotent: true, note: 'Read-only; safe to retry.' },
    description:
      'Ranked, capped retrieval across Sessions, Tracks and Playlists over the one shared match vocabulary; lyrics mode is Tracks-only.',
  },
  getDiagnostics: {
    method: 'GET',
    path: '/api/diagnostics',
    auth: 'admin',
    request: getDiagnosticsRequestSchema,
    response: getDiagnosticsResponseSchema,
    retry: { retryable: true, idempotent: true, note: 'Read-only; safe to retry.' },
    description: 'Worker heartbeat, provider validation, and usage (shown in tracks) diagnostics.',
  },
  getChrome: {
    method: 'GET',
    path: '/api/chrome',
    auth: 'admin',
    request: getChromeRequestSchema,
    response: getChromeResponseSchema,
    retry: { retryable: true, idempotent: true, note: 'Read-only; safe to retry/poll.' },
    description:
      'The app-shell chrome slice: the caller’s usage (shown in tracks) and active Session.',
  },
  validateProvider: {
    method: 'POST',
    path: '/api/providers/validate',
    auth: 'admin',
    request: validateProviderRequestSchema,
    response: validateProviderResponseSchema,
    retry: {
      retryable: true,
      idempotent: true,
      note: 'Read-only credential check; rate-limited server-side. Never returns raw provider errors.',
    },
    description: 'Validate a provider credential server-side (secrets never reach the client).',
  },
};
