// Generated Covers from OpenAI's Image API. A Cover without reference photos is
// an image generation; one with photos is an image edit carrying them, in the
// order given, as base64 data URLs in the JSON body. Output is always one square
// 1024px image, and the capabilities are fixed rather than discovered.

import { OPENAI_DEFAULT_COVER_MODEL } from '@liedmotif/shared';
import { pinnedProviderFetch } from '../validation/provider-fetch';
import {
  COVER_IMAGE_MEDIA_TYPES,
  GeneratedImageProviderError,
  type GeneratedImageCapabilities,
  type GeneratedImageCapabilityDowngrade,
  type GeneratedImageProvider,
} from './generated-image-contract';
import {
  acceptedReferences,
  extractImage,
  firstImageDatum,
  referenceDataUrl,
  submitGeneratedImageRequest,
} from './generated-image-wire';

export const OPENAI_IMAGES_BASE_URL = 'https://api.openai.com/v1';

const DEFAULT_TIMEOUT_MS = 60_000;
const VALIDATION_TIMEOUT_MS = 8_000;

/** OpenAI's documented prompt ceiling for the GPT image models. */
const MAX_PROMPT_CHARACTERS = 32_000;

/** The edit endpoint's documented ceiling on input images. */
const MAX_REFERENCES = 16;

/**
 * Keeps each base64'd reference well inside OpenAI's 20 MiB data-URL ceiling.
 * A People photo is a 1024px rendition, far below it.
 */
const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;

/**
 * Bounds the whole edit request: up to 16 photos at the per-photo cap would
 * otherwise base64 into a body of about 85 MiB. People photos are 1024px WebP
 * renditions, so a full set of them fits with room to spare.
 */
const MAX_TOTAL_REFERENCE_BYTES = 16 * 1024 * 1024;

export interface OpenAiImageConfig {
  apiKey: string;
  model?: string;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export function openAiImageProvider(config: OpenAiImageConfig): GeneratedImageProvider {
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new GeneratedImageProviderError('configuration', 'not_started');
  const model = config.model?.trim() || OPENAI_DEFAULT_COVER_MODEL;
  const timeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = config.fetch ?? pinnedProviderFetch({ providerKey: 'openai' });
  const providerMetadata = { providerType: 'image' as const, providerKey: 'openai', model };
  // Subject and style references without a multi-subject identity claim: what
  // OpenRouter's endpoint listing declares for OpenAI's own image models.
  const capabilities: GeneratedImageCapabilities = {
    provider: providerMetadata,
    maxPromptCharacters: MAX_PROMPT_CHARACTERS,
    exclusions: 'inline',
    nativeSeed: false,
    idempotency: 'absent',
    references: {
      roles: ['subject', 'style'],
      maxCount: MAX_REFERENCES,
      multiSubjectIdentity: false,
      mediaTypes: [...COVER_IMAGE_MEDIA_TYPES],
      maxBytesPerReference: MAX_REFERENCE_BYTES,
      maxTotalBytes: MAX_TOTAL_REFERENCE_BYTES,
    },
    squareOutput: 'native',
    maxCandidates: 1,
    costReporting: false,
  };

  return {
    ...providerMetadata,

    async getCapabilities() {
      return capabilities;
    },

    async generate(request) {
      if (request.count !== 1) {
        throw new GeneratedImageProviderError('configuration', 'not_started');
      }
      const references = acceptedReferences(request.references, capabilities);
      const downgrades: GeneratedImageCapabilityDowngrade[] = [];
      let prompt = request.positivePrompt;
      if (request.exclusions.length > 0) {
        prompt += `\n\nExclude: ${request.exclusions.join('; ')}.`;
        downgrades.push('exclusions_inlined');
      }
      if (prompt.length > MAX_PROMPT_CHARACTERS) {
        throw new GeneratedImageProviderError('rejection', 'not_started');
      }
      if (request.references.length > references.length) downgrades.push('references_omitted');
      if (request.seed !== undefined) downgrades.push('seed_omitted');
      downgrades.push('idempotency_unavailable');

      const body: Record<string, unknown> = {
        model,
        prompt,
        size: '1024x1024',
        // `auto` lets the model pick the tier, and with it the price.
        quality: request.target.quality === 'high' ? 'high' : 'medium',
        n: 1,
      };
      if (references.length > 0) {
        body.images = references.map((reference) => ({
          image_url: referenceDataUrl(reference),
        }));
      }
      const endpoint = references.length > 0 ? 'images/edits' : 'images/generations';
      const payload = await submitGeneratedImageRequest(
        fetchImpl,
        `${OPENAI_IMAGES_BASE_URL}/${endpoint}`,
        { apiKey, body, timeoutMs },
      );
      const image = extractImage(firstImageDatum(payload));
      if (!image) throw new GeneratedImageProviderError('invalid_response', 'outcome_unknown');
      return {
        provider: providerMetadata,
        ...image,
        appliedControls: {
          exclusions: 'inline',
          square: 'native',
          references: references.length,
          seed: false,
          idempotency: 'absent',
          candidateCount: 1,
        },
        downgradeCodes: downgrades,
      };
    },

    async validateCredentials() {
      // Retrieving the model is free and read-only, and it refuses a wrong key
      // (401) as well as a model the key cannot see (404).
      try {
        const response = await fetchImpl(
          `${OPENAI_IMAGES_BASE_URL}/models/${encodeURIComponent(model)}`,
          {
            headers: { authorization: `Bearer ${apiKey}` },
            redirect: 'manual',
            signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
          },
        );
        await response.body?.cancel().catch(() => undefined);
        return response.ok
          ? { ok: true, message: 'Image provider credentials and endpoint look valid.' }
          : { ok: false, message: 'Image provider credentials or endpoint were rejected.' };
      } catch {
        return { ok: false, message: 'Image provider credentials or endpoint were rejected.' };
      }
    },
  };
}
