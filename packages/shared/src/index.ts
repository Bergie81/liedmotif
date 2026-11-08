// Public surface of @liedmotif/shared: cross-cutting utilities consumed as
// TypeScript source by both web and worker.

export const SHARED_PACKAGE_VERSION = '0.0.0';

export {
  createLogger,
  createRedactor,
  redact,
  REDACTED,
  DEFAULT_SENSITIVE_KEY_FRAGMENTS,
  type Logger,
  type LoggerOptions,
  type LogFields,
  type RedactorOptions,
} from './logger';

export {
  getLogLevel,
  isLogLevel,
  isProduction,
  readIntEnv,
  requireEnv,
  type IntEnvRange,
  type LogLevel,
} from './env';

export {
  tokenize,
  normalizeTerm,
  slugify,
  escapeRegExp,
  clampAtWord,
  sanitizeCoverStyleHint,
  sanitizeCoverConcept,
  MAX_COVER_CONCEPT_LENGTH,
  derivePromptSessionName,
  capitalizeLowercaseTitle,
  MAX_PROMPT_SESSION_NAME_LENGTH,
  MAX_SESSION_TITLE_LENGTH,
  MAX_TRACK_TITLE_LENGTH,
  MAX_PLAYLIST_NAME_LENGTH,
} from './text';

export {
  canonicalPersonName,
  matchConfiguredPeople,
  replaceConfiguredPersonNames,
  type MatchablePerson,
} from './people';

export {
  extendPromptHistory,
  truncateTrackDataPrompt,
  MAX_TRACK_DATA_PROMPT_LENGTH,
} from './prompt-history';

export { type TimedLyricWord, type TimedLyrics } from './lyrics/timed';
export { buildLyricLines, type LyricLine, type LyricLinesResult } from './lyrics/lines';

export { hash01, hash32 } from './hash';

export {
  mapWithConcurrency,
  Semaphore,
  SemaphoreBusyError,
  type SemaphoreOptions,
} from './concurrency';

export {
  buildProviderDiagnostics,
  redactProviderDiagnostics,
  type ProviderDiagnostics,
  type RedactedJson,
} from './provider-diagnostics';

export {
  LLM_REASONING_EFFORTS,
  normalizeReasoningEffort,
  OPENAI_DEFAULT_LLM_MODEL,
  OPENAI_DEFAULT_REASONING_EFFORT,
  type LlmReasoningEffort,
} from './llm';

export {
  createRateLimiter,
  type RateLimiter,
  type RateLimiterOptions,
  type RateLimitResult,
} from './rate-limit';

export {
  installProcessErrorHandlers,
  teardownWithin,
  type ProcessErrorDeps,
  type TeardownDeps,
} from './process-lifecycle';

// State-machine contract (literals, transitions, invariants).
export * from './state-machines';

// Shared API contracts (Zod request/response schemas + inferred types).
export * from './contracts';
export * from './password';

// Usage-limit math: the single reset-window calculation
// and the cost-limit chokepoint, consumed by the worker buffer controller
// and the creation-time headroom gate.
export * from './limits';

// Pure player-domain logic: live-blend math + the
// generation-controller status presentation, consumed by the player's
// thin Web Audio wiring and the now-playing UI.
export * from './player';

// Pure feedback-domain logic: the sibling-first dislike-reroll chooser,
// shared by the web Dislike route and the worker buffer controller.
export * from './feedback';

// Minimal ID3v2 reader/writer: embeds the Session Cover + core text frames into
// locally stored final MP3s (worker `embed-track-metadata` job).
export {
  buildId3Tag,
  embedId3Tags,
  ID3_HEADER_SIZE,
  id3v2TagLength,
  LIEDMOTIF_TAG_MARKER,
  readId3Tags,
  stripId3v2,
  type Id3Artwork,
  type Id3Tags,
  type ParsedId3Tags,
} from './audio/id3';

// The one tag-set definition the worker writes and the download routes compare
// against, so "the stored file's tags are current" is exact by construction.
export {
  assembleTrackTags,
  buildTrackTag,
  type TrackTagContext,
  type TrackTagPlan,
} from './audio/track-tags';

// The one access seam for owned content: strictly viewer-is-owner,
// no admin override; the predicates a future sharing model widens.
export { canReadCover } from './access/owned-content';
