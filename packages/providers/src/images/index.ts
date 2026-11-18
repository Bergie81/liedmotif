// Image (cover-art) provider interface. A Session's Cover is generated
// asynchronously — by the prompt-driven image model when configured, else by the
// music provider's own cover art — and a fresh session wears the built-in
// branded placeholder until a generated cover lands. Cover art is cosmetic; it
// must never block playback or session creation.

export {
  openRouterImageProvider,
  parseOpenRouterImageParams,
  OPENROUTER_DEFAULT_COVER_MODEL,
  OPENROUTER_IMAGES_BASE_URL,
  OPENROUTER_IMAGE_PARAMS,
  COVER_IMAGE_MEDIA_TYPES,
  type CoverImageMediaType,
  GeneratedImageProviderError,
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
  type OpenRouterImageConfig,
  type OpenRouterImageParam,
} from './generated';
export {
  openAiImageProvider,
  OPENAI_IMAGES_BASE_URL,
  type OpenAiImageConfig,
} from './openai-image';
export {
  geminiImageProvider,
  GEMINI_IMAGES_BASE_URL,
  type GeminiImageConfig,
} from './gemini-image';
export { sunoCoverImageProvider, type SunoCoverImageConfig } from './suno-cover';
