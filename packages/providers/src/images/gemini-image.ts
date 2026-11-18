// Generated Covers from Gemini's native API. One `generateContent` call carries
// the prompt and then the reference photos as inline image parts, in the order
// given, and asks for one square 1K image. Gemini's OpenAI-compatible image
// endpoint takes no reference images, so it is not used. The capabilities are
// fixed rather than discovered.

import { GEMINI_DEFAULT_COVER_MODEL } from '@liedmotif/shared';
import { pinnedProviderFetch } from '../validation/provider-fetch';
import { fixedImageProvider } from './fixed-image-provider';
import {
  COVER_IMAGE_MEDIA_TYPES,
  GeneratedImageProviderError,
  type GeneratedImageProvider,
} from './generated-image-contract';
import {
  extractImage,
  referenceBase64,
  submitGeneratedImageRequest,
  type GeneratedImageRefusalClassifier,
} from './generated-image-wire';

export const GEMINI_IMAGES_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const DEFAULT_TIMEOUT_MS = 60_000;

/** Gemini keeps up to four characters consistent across one image. */
const MAX_SUBJECT_REFERENCES = 4;

/** A People photo is a 1024px rendition, far below it. */
const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;

/**
 * Gemini caps a request with inline data at 20 MB in total. Base64 grows the
 * photos by a third, so 12 MiB of them stays under it with room for the prompt.
 */
const MAX_TOTAL_REFERENCE_BYTES = 12 * 1024 * 1024;

/**
 * Google's documented refusals of a project that is not set up to pay:
 * `FAILED_PRECONDITION` (a prerequisite such as billing is not met) and
 * `PERMISSION_DENIED` carrying the `FREE_TIER_VERIFICATION_REQUIRED` reason
 * (verify the project or turn on billing) or the `BILLING_DISABLED` reason.
 * Every other refusal keeps its status classification.
 */
const ACCOUNT_NOT_READY_REASONS: readonly unknown[] = [
  'FREE_TIER_VERIFICATION_REQUIRED',
  'BILLING_DISABLED',
];

const classifyRefusal: GeneratedImageRefusalClassifier = (status, error) => {
  const reasons = Array.isArray(error.details)
    ? error.details.map((detail) => (detail as { reason?: unknown } | null)?.reason)
    : [];
  const accountNotReady =
    (status === 400 && error.status === 'FAILED_PRECONDITION') ||
    (status === 403 &&
      error.status === 'PERMISSION_DENIED' &&
      reasons.some((reason) => ACCOUNT_NOT_READY_REASONS.includes(reason)));
  return accountNotReady
    ? new GeneratedImageProviderError('account_not_ready', 'not_started')
    : null;
};

export interface GeminiImageConfig {
  apiKey: string;
  model?: string;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

interface GeminiPart {
  text?: unknown;
  thought?: unknown;
  inlineData?: { mimeType?: unknown; data?: unknown };
}

export function geminiImageProvider(config: GeminiImageConfig): GeneratedImageProvider {
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new GeneratedImageProviderError('configuration', 'not_started');
  // Google names models `models/<id>` in its lists, and the key Test accepts
  // either form, but the request path takes the bare id.
  const model = config.model?.trim().replace(/^models\//, '') || GEMINI_DEFAULT_COVER_MODEL;
  const timeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = config.fetch ?? pinnedProviderFetch({ providerKey: 'gemini' });
  const authHeaders = { 'x-goog-api-key': apiKey };
  const modelUrl = `${GEMINI_IMAGES_BASE_URL}/models/${encodeURIComponent(model)}`;

  return fixedImageProvider({
    providerKey: 'gemini',
    model,
    references: {
      roles: ['subject'],
      maxCount: MAX_SUBJECT_REFERENCES,
      multiSubjectIdentity: true,
      mediaTypes: [...COVER_IMAGE_MEDIA_TYPES],
      maxBytesPerReference: MAX_REFERENCE_BYTES,
      maxTotalBytes: MAX_TOTAL_REFERENCE_BYTES,
    },
    fetchImpl,
    // Reading the model is free and read-only, and it refuses a wrong key as
    // well as a model the key cannot see.
    keyCheck: { url: modelUrl, headers: authHeaders },
    async paint({ prompt, references }) {
      const body = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              ...references.map((reference) => ({
                inlineData: { mimeType: reference.mediaType, data: referenceBase64(reference) },
              })),
            ],
          },
        ],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio: '1:1', imageSize: '1K' },
        },
      };
      const payload = await submitGeneratedImageRequest(fetchImpl, `${modelUrl}:generateContent`, {
        authHeaders,
        body,
        timeoutMs,
        classifyRefusal,
      });
      return imageFromReply(payload);
    },
  });
}

/** Finish reasons that mean Gemini refused the request on content grounds. */
const BLOCKED_FINISH_REASONS = new Set([
  'SAFETY',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'RECITATION',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION',
]);

/**
 * The last non-thought image of the first candidate. A reply without one is a
 * content refusal when Gemini says so, which is terminal but may still have
 * been billed for the prompt, and an invalid response otherwise.
 */
function imageFromReply(payload: unknown) {
  const reply = payload as {
    candidates?: unknown;
    promptFeedback?: { blockReason?: unknown };
  } | null;
  const candidate = Array.isArray(reply?.candidates)
    ? (reply.candidates[0] as { content?: { parts?: unknown }; finishReason?: unknown } | undefined)
    : undefined;
  const parts = Array.isArray(candidate?.content?.parts)
    ? (candidate.content.parts as GeminiPart[])
    : [];
  const part = parts.findLast((entry) => entry?.inlineData && entry.thought !== true);
  const image = part?.inlineData
    ? extractImage({ b64_json: part.inlineData.data, mime_type: part.inlineData.mimeType })
    : null;
  if (image) return image;
  const blocked =
    Boolean(reply?.promptFeedback?.blockReason) ||
    (typeof candidate?.finishReason === 'string' &&
      BLOCKED_FINISH_REASONS.has(candidate.finishReason));
  throw new GeneratedImageProviderError(
    blocked ? 'rejection' : 'invalid_response',
    'outcome_unknown',
  );
}
