// TypeScript shapes for the schema's `jsonb` columns, attached via Drizzle's
// `.$type<T>()`. They give callers typed reads/writes without a runtime
// dependency (no Zod in `@liedmotif/db`). The genuinely-known shapes
// (`UsageLimits`, `EncryptedSecret`) are strict; the Style-Snapshot / controls /
// metadata shapes are intentionally permissive, so they
// allow forward fields without a migration.

import type { CoverStyleChoice } from '@liedmotif/shared';

/**
 * Global usage limits, stored as a single typed object in `app_settings`
 * under the `usageLimits` key (there is no `usageLimits` table). Counted
 * internally in provider calls (tasks/ProviderJobs); always shown to the user in
 * tracks. Defaults live in `settings.ts`.
 */
export interface UsageLimits {
  /**
   * Whether the daily and monthly caps below bind the Admin's own generation.
   * Concurrency and queue depth bind either way, and
   * Members are held to their own budget and the Members Pool regardless.
   */
  trackCeilingEnabled: boolean;
  /** Daily provider-call (task) cap. Default 40 (~80 Suno tracks/day). */
  dailyGenerationTasks: number;
  /** Monthly provider-call (task) cap. Default 400. */
  monthlyGenerationTasks: number;
  /** IANA timezone the daily/monthly windows reset in. Default `INSTANCE_TIMEZONE` or `UTC`. */
  resetTimezone: string;
  /** Max simultaneous in-flight provider jobs. Default 1. */
  maxConcurrentJobs: number;
  /** Max ready-ahead queued tracks per session. Default 6. */
  maxQueuedTracks: number;
  /** Confirm-still-listening cutoff. Default 60. */
  maxSessionMinutesWithoutConfirmation: number;
  /** Retry budget per failed provider job. Default 2. */
  maxRetriesPerJob: number;
  /** Local storage quota in bytes. Default 10 GiB. */
  storageQuotaBytes: number;
  /** When true, never auto-generate; the admin triggers each batch. Default false. */
  manualGenerationOnly: boolean;
  /** Auto-stop an active session after this many idle minutes. Default 15. */
  idleAutoStopAfterMinutes: number;
  /**
   * Minimum remaining headroom (in tracks) required to Start Session / More Like
   * This; below it, creation is blocked and the user is prompted to Resume or browse
   * the Library. Resume is never gated. Default 5.
   */
  minHeadroomTracksToStartSession: number;
  /**
   * Whether Session Covers are painted by the image provider — prompt-driven, so
   * they can honor the chosen cover style and the owner's People. It gates only
   * that source: it additionally requires image-provider credentials, and with it
   * off (or unconfigured) covers come from the music provider's own cover art
   * instead, which is drawn from the music alone. The shared cover budget below
   * applies to both. Default true.
   */
  tailoredCoverArtEnabled: boolean;
  /** `trackCeilingEnabled` for the two Cover caps below. */
  coverCeilingEnabled: boolean;
  /** Daily cap on successfully generated Session Covers. Default 20. */
  generatedCoversPerDay: number;
  /** Monthly cap on successfully generated Session Covers. Default 300. */
  generatedCoversPerMonth: number;
}

/**
 * Instance-level configuration recorded at first run, stored as a single typed
 * object in `app_settings` under the `instance` key. The reset timezone is NOT here
 * — `usageLimits.resetTimezone` owns it, because that is the value the daily and
 * monthly windows actually roll over on. `setupCompletedAt` is the ISO timestamp the
 * first admin finished setup (a convenience marker — the authoritative "setup done"
 * signal is the existence of an admin).
 */
export interface InstanceSettings {
  name: string;
  publicUrl: string;
  setupCompletedAt?: string;
}

/**
 * The worker's liveness report, stored as one typed object in `app_settings`
 * under the `workerHeartbeat` key and upserted every heartbeat interval. The
 * worker process is the only writer; `state` mirrors its readiness union
 * (`starting` = boot underway, `ready` = the Graphile runner is up, `degraded` =
 * alive but unable to run jobs). `concurrency` is the runner's job-slot count —
 * only the worker can resolve it, so it rides the heartbeat for diagnostics.
 * Timestamps are ISO strings; freshness is judged against `ts`.
 */
export interface WorkerHeartbeat {
  ts: string;
  pid: number;
  state: 'starting' | 'ready' | 'degraded';
  concurrency: number;
  startedAt: string;
}

export type InstanceAlertCondition = 'worker-heartbeat' | 'failed-jobs' | 'storage-quota';

export type InstanceAlertSeverity = 'warning' | 'critical';

/**
 * What Instance alerts last announced, in `app_settings`. Absent means not
 * currently announced. `severity` is the level last announced; `since` is when the
 * condition first fired and survives severity changes, so a recovery reports the
 * whole incident.
 */
export type InstanceAlertsState = Partial<
  Record<InstanceAlertCondition, { severity: InstanceAlertSeverity; since: string }>
>;

/**
 * Instance-wide generated-cover preferences, stored as one typed object in
 * `app_settings` under the `coverArt` key. `defaultStyle` is what the create
 * card's `Cover style` dropdown preselects (any lane, `auto`, or `custom`);
 * each session can still override it. `customStyleDefinition` is the saved
 * `Custom` cover style (Settings → Cover Arts): a style HINT for the cover
 * pipeline, never the final image prompt. Empty means "not defined" — a session
 * started with the `Custom` choice then falls back to `auto` (covers are
 * cosmetic and never block Start Session).
 */
export interface CoverArtSettings {
  defaultStyle: CoverStyleChoice;
  customStyleDefinition: string;
  /**
   * Default cover source for new sessions: standard covers from the music
   * provider's own cover-art endpoint (no style control, no extra cost)
   * instead of styled image-provider covers. Each session can override it;
   * hand-tuned (no-AI) sessions default to standard regardless.
   */
  useStandardCoverArt: boolean;
  /**
   * Whether user-written cover text (regenerate guidance, custom style
   * definitions) is rewritten by the text LLM before generation. Default true;
   * a configured LLM is the hard gate — without one this setting is inert.
   * Per-generation switches override it for a single attempt.
   */
  promptEnhancementEnabled: boolean;
}

/**
 * A secret encrypted at rest with AES-256-GCM. Stored as JSON so the IV,
 * auth tag, and ciphertext travel together with a version for future rotation.
 * `null` is valid when the credential is env-sourced (no DB-stored secret).
 */
export interface EncryptedSecret {
  /** Encryption scheme version, for future key rotation / re-encryption. */
  v: number;
  /** Base64 12-byte random IV. */
  iv: string;
  /** Base64 GCM auth tag. */
  tag: string;
  /** Base64 ciphertext. */
  ciphertext: string;
}

/** Free-form provider config blob (base URL, model preset, headers flags, …). */
export type ProviderConfig = Record<string, unknown>;

/**
 * A pre-spend cost estimate. Provider-native units (e.g. Suno credits) plus the
 * task/track conversion; deliberately no invented dollar amounts.
 */
export interface CostEstimate {
  /** Provider calls this request will consume. */
  tasks?: number;
  /** Tracks the user will see (tasks × provider tracks-per-call). */
  tracks?: number;
  /** Provider-native credits, when known. */
  providerCredits?: number;
  /** Anything else a provider wants to record. */
  [key: string]: unknown;
}

/**
 * Structured-controls input — compiled into a Style Snapshot by a
 * deterministic template (no text LLM). Permissive shape.
 */
export interface StructuredControls {
  activity?: string;
  mood?: string;
  energy?: string;
  genre?: string | string[];
  vocal?: 'instrumental' | 'vocal';
  durationMinutes?: number;
  [key: string]: unknown;
}

/**
 * The frozen `sessionStyleSnapshot` a Session reuses to build every track's
 * prompt. Produced two ways (text LLM or deterministic template),
 * both converging on this shape. Freezes a single BPM/key for blend-for-free;
 * variety comes from `seedParameters`. Permissive shape.
 */
export interface StyleSnapshot {
  stylePrompt?: string;
  negativeTerms?: string[];
  mood?: string;
  activity?: string;
  genreTags?: string[];
  vocalMode?: 'instrumental' | 'vocal';
  energy?: string;
  /** LLM-proposed session Name (cosmetic); ''/absent → derived deterministically. */
  title?: string;
  /** LLM-proposed creative track-title pool, cycled per track ordinal. */
  trackTitles?: string[];
  /** LLM-produced compact personal lyric notes for vocal sessions; ''/absent otherwise. */
  lyricContext?: string;
  /** Detected request language for vocal sessions (e.g. "German"); ''/absent otherwise. */
  language?: string;
  /** Sing with the user's own voice profile (vocal sessions only). */
  useOwnVoice?: boolean;
  /**
   * Session Guardrails, frozen here so every Track of a
   * vibe — Dislike rerolls included — generates under the same constraints.
   * `styleStrength`/`novelty` are 0–1 levels the music adapter maps to its own
   * parameters; both absent means a pre-guardrails Session, which must keep
   * compiling with the parameters OMITTED. `userAvoid` is the user's Avoid text
   * verbatim (the editable identity Change Vibe re-seeds); its parsed terms are
   * already merged into `negativeTerms`, so nothing downstream re-splits it.
   */
  styleStrength?: number;
  novelty?: number;
  userAvoid?: string;
  /** Frozen for the whole Session so consecutive tracks beat-match. */
  bpm?: number;
  /** Frozen musical key for harmonic mixing. */
  key?: string;
  /** Hidden seed parameters rotated for per-track variety / reroll. */
  seedParameters?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A point-in-time copy of the taste profile that shaped a session. */
export type TasteProfileSnapshot = Record<string, unknown>;

/** Provider/rights provenance carried with a track for later export. */
export interface LicenseMetadata {
  provider?: string;
  model?: string;
  rightsNote?: string;
  [key: string]: unknown;
}

/** Manifest tags / fit vectors / provenance / attribution blobs for covers. */
export type CoverMetadata = Record<string, unknown>;
