// Postgres enum types for the Liedmotif application schema.
//
// Enum-vs-text rule (kept consistent across the schema and documented in the
// package README): a value set becomes a `pgEnum` only when it is a closed
// contract — i.e. the job, track and queue state machines and the fixed
// lifecycle/discriminator sets. Open vocabularies that grow with new adapters or
// aren't pinned yet stay `text` to avoid `ALTER TYPE` churn on every new provider: `providerKey`, `usage_events`
// `operation`, `provider_credentials.validationStatus`, `generation_requests`
// `status`, `storageProvider`, and `deletion_queue_items.reason`.

import { pgEnum } from 'drizzle-orm/pg-core';

/** `providerType` discriminator shared by credentials, usage, requests, jobs. */
export const providerType = pgEnum('provider_type', ['music', 'llm', 'image', 'storage']);

/** Where a resolved provider credential came from (env override vs DB-stored). */
export const credentialSource = pgEnum('credential_source', ['env', 'database']);

/** What user intent produced a GenerationRequest. */
export const generationSource = pgEnum('generation_source', [
  'prompt',
  'controls',
  'more_like_this',
  'change_vibe',
]);

/**
 * Money-idempotency state of a paid provider submit.
 * `submit_unknown` is the no-auto-retry state: the network failed before a
 * provider taskId was captured, so the provider may have accepted a paid call.
 * `submit_rejected` is its provably-unbilled twin: the provider refused the
 * call outright (a definitive 4xx) or the adapter refused it before dialing, so
 * the row is failed but never counted as spend.
 */
export const providerSubmitState = pgEnum('provider_submit_state', [
  'not_submitted',
  'submitting',
  'submitted',
  'submit_unknown',
  'submit_rejected',
]);

/**
 * Submit states that count as (possible) SPEND — the daily/monthly limit
 * windows' whole definition of a paid task. `submit_unknown` counts: the network
 * failed before a task id was captured, so the provider may have accepted a paid
 * call, and counting it keeps limits money-conservative. `submit_rejected` is the
 * one submit state deliberately absent: the provider definitively refused the
 * call before charging, so counting it would burn a whole budget window on an
 * outage or a bad credential with zero tracks to show for it. Adding a state here
 * must always be the safe direction — when in doubt, count it.
 *
 * Lives beside the enum because BOTH the counting query (`countTasksInWindow`)
 * and the partial index that serves it (`provider_jobs_spend_window_idx`) are
 * built from this one list; were they to drift, the index would silently stop
 * covering the money path's hottest read.
 */
export const SPEND_SUBMIT_STATES = ['submitting', 'submitted', 'submit_unknown'] as const;

/** The list above as SQL literals, for the index predicate. */
export const spendSubmitStateSqlList = SPEND_SUBMIT_STATES.map((state) => `'${state}'`).join(', ');

/**
 * Provider-agnostic job status the app reasons about (written only by
 * worker jobs).
 */
export const providerNormalizedStatus = pgEnum('provider_normalized_status', [
  'queued',
  'submitted',
  'submit_unknown',
  'submit_rejected',
  'processing',
  'partially_ready',
  'ready',
  'failed_retryable',
  'failed_final',
  'blocked_by_liedmotif_limit',
  'blocked_by_provider_credits',
  'provider_rate_limited',
  'blocked_by_policy',
]);

/** Track readiness/lifecycle. */
export const trackStatus = pgEnum('track_status', [
  'pending',
  'streamable',
  'ready',
  'rejected',
  'deleted',
  'failed',
]);

/** Instrumental by default, vocals opt-in. */
export const vocalMode = pgEnum('vocal_mode', ['instrumental', 'vocal']);

/**
 * Per-track audio-analysis provenance.
 * `pending` = not analyzed yet; `measured` = real LUFS + measured BPM grids;
 * `partial` = LUFS measured but BPM anchored; `unavailable` = the host cannot
 * measure (no ffmpeg — the anchored-only estimator always lands here, and
 * the boot probe re-enqueues these when ffmpeg appears); `failed` =
 * analysis errored. Fake/anchored data must be distinguishable from measured
 * data — this enum is what makes that structural.
 */
export const analysisStatus = pgEnum('analysis_status', [
  'pending',
  'measured',
  'partial',
  'unavailable',
  'failed',
]);

/** Where `tracks.bpm_estimate` came from: measured from the audio, or anchored
 *  to the generation-time target. Only `measured` may activate beat-locking. */
export const bpmSource = pgEnum('bpm_source', ['measured', 'anchored']);

/** Which audio source a `track_audio_assets` row represents (the cold-start ladder). */
export const audioAssetType = pgEnum('audio_asset_type', [
  'provider_stream',
  'provider_final',
  'local_original',
]);

/**
 * Where a cover image came from. `stock`, `unsplash`, and `procedural` are
 * declared but never written: Postgres cannot drop an enum value in place, so a
 * value that no code produces still has to stay in the type.
 */
export const coverSourceType = pgEnum('cover_source_type', [
  'stock',
  'generated',
  'uploaded',
  'unsplash',
  'procedural',
  'placeholder',
]);

/**
 * How often uploaded profile reference images may appear in generated Session
 * Covers (`listener_profiles.cover_reference_frequency`). `never` is a HARD privacy
 * opt-out: reference bytes and descriptions are not even loaded, let alone sent
 * to the image provider.
 */
export const coverReferenceFrequency = pgEnum('cover_reference_frequency', [
  'always',
  'regularly',
  'seldom',
  'never',
]);

/**
 * User-selected art-direction lane for the generated Session Cover
 * (`activity_sessions.cover_style`). Pinned by the cover-art UX doc (the exact
 * option set, no `3d_object`); `auto` lets the cover prompt pipeline pick the
 * lane from the Session intent + Style Snapshot. Steers cover style only —
 * never the music Style Snapshot or generation prompt. The VALUE SET is parity-
 * guarded against the shared `COVER_STYLES` contract; declaration order is not,
 * since only `COVER_STYLES` decides how the lanes are presented.
 */
export const coverStyle = pgEnum('cover_style', [
  'auto',
  'poster_art',
  'photographic',
  'minimal',
  'drawing',
  'custom',
]);

export const sessionCoverGenerationState = pgEnum('session_cover_generation_state', [
  'not_admitted',
  'reserved',
  'planned',
  'submitting',
  'storing',
  'ready',
  'quality_rejected',
  'provider_unavailable',
  'provider_rejected',
  'submission_unknown',
  'storage_rejected',
  'privacy_rejected',
]);

/**
 * What initiated a Session Cover generation attempt: the automatic attempt at
 * Session creation, a worker recovery pass, or an explicit user regeneration
 * from the player. A failed attempt keeps the Session's
 * current cover (the branded placeholder for an initial attempt).
 */
export const sessionCoverTrigger = pgEnum('session_cover_trigger', [
  'initial',
  'recovery',
  'user_regenerate',
]);

/**
 * Playlist discriminator: `user` playlists
 * are created/renamed/deleted freely; `favorites` is the per-owner system
 * playlist behind the star — fixed name, undeletable, unrenamable.
 */
export const playlistKind = pgEnum('playlist_kind', ['user', 'favorites']);

/**
 * Who an In-Lounge playlist reaches: `everyone` is every
 * signed-in User on the Instance, including Users who join later; `selected` is
 * exactly the Users listed in `playlist_share_members`. Meaningful only while
 * the playlist's `sharedAt` is set.
 */
export const playlistShareAudience = pgEnum('playlist_share_audience', ['everyone', 'selected']);

/**
 * Audit-trail feedback actions. Deliberately has **no `like`** —
 * positive signal is inaction. `skip` is the soft-negative; `dislike` is the
 * reroll/reject action; save/favorite (+ their inverses) are retention.
 */
export const feedbackType = pgEnum('feedback_type', [
  'save',
  'unsave',
  'favorite',
  'unfavorite',
  'dislike',
  'skip',
]);

/**
 * Session lifecycle. Exactly two states:
 * the at-most-one live `active` session or `stopped`. No `paused`/`completed` —
 * a cost limit degrades a running session to Session Repeat (a `generationStatus`,
 * never a lifecycle state), and every exit lands on `stopped`, which Resume
 * re-activates.
 */
export const activitySessionStatus = pgEnum('activity_session_status', ['active', 'stopped']);

/**
 * Why a session became Stopped (`activity_sessions.end_reason`, nullable) — recorded
 * on the lifecycle exit, not a state. `superseded` is the Start/More-Like-This/Resume
 * case; `idle_timeout` is the worker idle auto-stop.
 */
export const sessionEndReason = pgEnum('session_end_reason', [
  'user_stopped',
  'completed_duration',
  'superseded',
  'idle_timeout',
]);

/**
 * Generation-controller status (`activity_sessions.generation_status`).
 * "limit reached" and other generation blocks are a controller property, NOT a
 * lifecycle state — the session stays `active` throughout. `repeat_cost_limit` is
 * the cost-limit Session-Repeat case (replacing the old `liedmotif_limit` pause
 * reason). Written only by the worker / buffer controller.
 * `repeat_buffer_complete` is legacy — never emitted by the controller, retained
 * because removing a Postgres enum value requires a type rebuild.
 */
export const sessionGenerationStatus = pgEnum('session_generation_status', [
  'ok',
  'repeat_cost_limit',
  'repeat_buffer_complete',
  'provider_credits',
  'provider_rate_limited',
  'worker_stalled',
  'provider_error',
]);

/**
 * Session generation policy (`activity_sessions.session_mode`) — the sole
 * authority over automatic top-ups. `keep_going` generates
 * indefinitely; `repeat` loops the session's own tracks at zero cost — the
 * voluntary form of Session Repeat. New sessions start in the mode the owner's
 * `bufferEnabled` default selects. Written only by API routes (user intent).
 */
export const sessionMode = pgEnum('session_mode', ['keep_going', 'repeat']);

/** Queue-item state (written by buffer controller + playback API). */
export const queueItemState = pgEnum('queue_item_state', [
  'planned',
  'generating',
  'queued',
  'playing',
  'played',
  'skipped',
  'rejected',
  'failed',
]);

/** Persisted playback events (only these four are persisted; position pings are not). */
export const playbackEventType = pgEnum('playback_event_type', [
  'started',
  'ended',
  'skipped',
  'failed',
]);

/**
 * Voice-profile lifecycle (Settings -> My voice, "user voice" feature). Client
 * capture states (recording/cleaning) are UI-only; the row tracks the
 * provider-facing workflow: `draft` (collecting recordings) ->
 * `validating_source` -> `awaiting_verification` (provider phrase known) ->
 * `creating_voice` -> `ready`. `failed` keeps recordings for a retry;
 * `disabled` keeps the profile but hides it from Session creation.
 */
export const voiceProfileStatus = pgEnum('voice_profile_status', [
  'draft',
  'validating_source',
  'awaiting_verification',
  'creating_voice',
  'ready',
  'failed',
  'disabled',
]);

/** The two recordings a voice profile owns (one per kind, replaced on re-record). */
export const voiceRecordingKind = pgEnum('voice_recording_kind', ['source', 'verification']);
