// Generated Covers from OpenAI's Image API. A Cover without reference photos is
// an image generation; one with photos is an image edit carrying them, in the
// order given, as base64 data URLs in the JSON body. Output is always one square
// 1024px image, and the capabilities are fixed rather than discovered.

import { OPENAI_DEFAULT_COVER_MODEL } from '@liedmotif/shared';
import { pinnedProviderFetch } from '../validation/provider-fetch';
import { fixedImageProvider } from './fixed-image-provider';
import {
  COVER_IMAGE_MEDIA_TYPES,
  GeneratedImageProviderError,
  type GeneratedImageProvider,
} from './generated-image-contract';
import {
  extractImage,
  firstImageDatum,
  referenceDataUrl,
  submitGeneratedImageRequest,
  type GeneratedImageRefusalClassifier,
} from './generated-image-wire';

export const OPENAI_IMAGES_BASE_URL = 'https://api.openai.com/v1';

const DEFAULT_TIMEOUT_MS = 60_000;

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

/**
 * GPT Image models need API Organization Verification. OpenAI gives the refusal
 * no error code (`code` is null), so the 403 is recognised by the sentence its
 * message opens with; any other 403 stays a configuration failure.
 */
const UNVERIFIED_ORGANIZATION = /organization must be verified/i;

const classifyRefusal: GeneratedImageRefusalClassifier = (status, error) =>
  status === 403 && typeof error.message === 'string' && UNVERIFIED_ORGANIZATION.test(error.message)
    ? new GeneratedImageProviderError('account_not_ready', 'not_started')
    : null;

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
  const authHeaders = { authorization: `Bearer ${apiKey}` };

  return fixedImageProvider({
    providerKey: 'openai',
    model,
    maxPromptCharacters: MAX_PROMPT_CHARACTERS,
    // Subject and style references without a multi-subject identity claim: what
    // OpenRouter's endpoint listing declares for OpenAI's own image models.
    references: {
      roles: ['subject', 'style'],
      maxCount: MAX_REFERENCES,
      multiSubjectIdentity: false,
      mediaTypes: [...COVER_IMAGE_MEDIA_TYPES],
      maxBytesPerReference: MAX_REFERENCE_BYTES,
      maxTotalBytes: MAX_TOTAL_REFERENCE_BYTES,
    },
    fetchImpl,
    // Retrieving the model is free and read-only, and it refuses a wrong key
    // (401) as well as a model the key cannot see (404).
    keyCheck: {
      url: `${OPENAI_IMAGES_BASE_URL}/models/${encodeURIComponent(model)}`,
      headers: authHeaders,
    },
    async paint({ prompt, references, quality }) {
      const body: Record<string, unknown> = {
        model,
        prompt,
        size: '1024x1024',
        // `auto` lets the model pick the tier, and with it the price.
        quality: quality === 'high' ? 'high' : 'medium',
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
        { authHeaders, body, timeoutMs, classifyRefusal },
      );
      const image = extractImage(firstImageDatum(payload));
      if (!image) throw new GeneratedImageProviderError('invalid_response', 'outcome_unknown');
      return image;
    },
  });
}
