// Public surface of @liedmotif/providers. Vendor-facing capabilities are reached
// through these interfaces and the registry; no app code imports a vendor SDK.

export type {
  ProviderType,
  ProviderValidationResult,
  BaseProvider,
  ProviderMetadata,
  ProviderDiagnostics,
  RedactedJson,
  NormalizedProviderResult,
} from './types';

export { redactProviderDiagnostics, buildProviderDiagnostics } from '@liedmotif/shared';

export { ProviderRegistry, type RegistrableProvider } from './registry';

export {
  assembleLlmRuntimeConfig,
  buildMusicProvider,
  buildLlmProvider,
  buildGeneratedImageProvider,
  buildSunoCoverImageProvider,
  imageProviderSelection,
  musicProviderSelection,
  musicTracksPerRequest,
  type MusicProviderSelection,
  type MusicRuntimeConfig,
  type LlmRuntimeConfig,
  type ResolvedLlmSettings,
  type GeneratedImageRuntimeConfig,
} from './registries';

export {
  mockMusicProvider,
  MOCK_PROVIDER_VOICE_ID,
  MOCK_VERIFICATION_PHRASE,
  type MockMusicOptions,
} from './music/mock';
export { sunoMusicProvider, type SunoMusicConfig } from './music/suno';
export {
  compileMusicGenerationInput,
  compileRerollInput,
  type CompileMusicInputOptions,
  type RerollSubmitContext,
} from './music/compile';
export {
  anchoredBpmEstimate,
  targetAnchoredBpmAnalyzer,
  MAX_ANCHORED_BPM_DRIFT,
  type TrackAudioAnalyzer,
  type TrackAudioAnalysisInput,
  type TrackBpmEstimate,
  type TrackAnalysisOutcome,
  type TrackAudioRef,
} from './music/analyzer';
export { mockLlmProvider } from './llm/mock';

export type {
  MusicProvider,
  MusicProviderCapabilities,
  MusicCustomVoiceCapability,
  MusicGenerationMode,
  MusicGenerationInput,
  GenerationCostEstimate,
  ProviderJobStatus,
  MusicFailureReason,
  NormalizedTrack,
  MusicGenerationTask,
  MusicGenerationStatusResult,
  MusicVoiceApi,
  VoiceAudioSource,
  VoiceSetupStatus,
  VoiceValidationStatusResult,
  VoiceCreationStatusResult,
  TimedLyrics,
  TimedLyricWord,
} from './music/index';

export type {
  LlmProvider,
  LlmProviderCapabilities,
  LlmTool,
  AssistantMessage,
  AssistantReplyInput,
  CoverDirectionInput,
  CoverDirectionEnhancement,
  ListenerContext,
  SessionStyleSnapshot,
  VocalMode,
  EnergyLevel,
  StructuredControls,
  TrackPromptParams,
  TrackMetadata,
  OpenAiCompatibleLlmConfig,
  SessionIntentInput,
  SessionNamingMetadata,
  ExpansionOptions,
  TrackLyricBriefInput,
  TrackTitlesInput,
  SurpriseRequestInput,
  SurpriseRequest,
} from './llm/index';

export {
  sessionStyleSnapshotSchema,
  MAX_STYLE_PROMPT_LENGTH,
  MAX_TRACK_TITLE_POOL,
  trackTitleRefillCount,
  compileStructuredControls,
  buildSessionStyle,
  buildTrackPrompt,
  deriveTrackMetadata,
  deriveSiblingTrackTitles,
  deriveSessionSnapshot,
  deriveSessionMetadata,
  deriveSessionTitle,
  inheritedGuardrails,
  createOpenAiCompatibleLlmProvider,
  createOpenRouterLlmProvider,
  createOllamaLlmProvider,
} from './llm/index';

export {
  ProviderError,
  ProviderConfigError,
  ProviderEgressError,
  ProviderUnbilledError,
} from './errors';

// Async generated Session Cover art (OpenRouter, OpenAI, Gemini) + its deterministic prompt pipeline.
export {
  geminiImageProvider,
  openAiImageProvider,
  openRouterImageProvider,
  parseOpenRouterImageParams,
  OPENROUTER_DEFAULT_COVER_MODEL,
  COVER_IMAGE_MEDIA_TYPES,
  GeneratedImageProviderError,
  type CoverImageMediaType,
  type GeneratedImageCapabilities,
  type GeneratedImageCapabilityDowngrade,
  type GeneratedImageFailureKind,
  type GeneratedImageProvider,
  type GeneratedImageReference,
  type GeneratedImageReferenceCapabilities,
  type GeneratedImageReferenceRole,
  type GeneratedImageRequest,
  type GeneratedImageResult,
  type GeneratedImageSubmissionDisposition,
  type OpenRouterImageCapabilityAssertion,
} from './images/index';

export { sunoCoverImageProvider, type SunoCoverImageConfig } from './images/index';

export {
  validateCredential,
  type CredentialValidationInput,
  type CredentialValidationResult,
  type ValidationReason,
} from './validation/index';

export {
  normalizeProviderBaseUrl,
  type ProviderBaseUrlRejection,
  type ProviderBaseUrlResult,
} from './validation/base-url';

export {
  isBlockedValidationTarget,
  isBlockedValidationTargetResolved,
  isBlockedResolvedHost,
  isPrivateHost,
  isLoopbackHost,
  assertAllowedBaseUrl,
  type ResolveHostAddresses,
} from './validation/ssrf';

export {
  fetchProviderMedia,
  type FetchProviderMediaOptions,
  type PinnedFetch,
} from './validation/egress';

export { boundedResponseStream, declaredResponseBytes } from './validation/response-limit';
