// The generated-image adapters whose capabilities are fixed rather than
// discovered share one shape: exclusions are inlined into the prompt, there is no
// seed, no idempotency key and no cost report, and each request paints one
// natively square image. The adapter supplies only its limits, how it paints, and
// the free request that checks its key.

import {
  GeneratedImageProviderError,
  type CoverImageMediaType,
  type GeneratedImageCapabilities,
  type GeneratedImageCapabilityDowngrade,
  type GeneratedImageProvider,
  type GeneratedImageReference,
  type GeneratedImageReferenceCapabilities,
  type GeneratedImageRequest,
} from './generated-image-contract';
import { acceptedReferences } from './generated-image-wire';

const VALIDATION_TIMEOUT_MS = 8_000;

export interface FixedImageAdapter {
  providerKey: string;
  model: string;
  maxPromptCharacters?: number;
  references: GeneratedImageReferenceCapabilities;
  fetchImpl: typeof fetch;
  /** A free, read-only request that refuses a wrong key and a model the key cannot see. */
  keyCheck: { url: string; headers: Record<string, string> };
  /** One image from the final prompt and the references that fit the limits, in order. */
  paint(input: {
    prompt: string;
    references: GeneratedImageReference[];
    quality: GeneratedImageRequest['target']['quality'];
  }): Promise<{ bytes: Uint8Array; mediaType: CoverImageMediaType }>;
}

export function fixedImageProvider(adapter: FixedImageAdapter): GeneratedImageProvider {
  const { maxPromptCharacters, fetchImpl, keyCheck } = adapter;
  const provider = {
    providerType: 'image' as const,
    providerKey: adapter.providerKey,
    model: adapter.model,
  };
  const capabilities: GeneratedImageCapabilities = {
    provider,
    ...(maxPromptCharacters ? { maxPromptCharacters } : {}),
    exclusions: 'inline',
    nativeSeed: false,
    idempotency: 'absent',
    references: adapter.references,
    squareOutput: 'native',
    maxCandidates: 1,
    costReporting: false,
  };

  return {
    ...provider,

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
      if (maxPromptCharacters && prompt.length > maxPromptCharacters) {
        throw new GeneratedImageProviderError('rejection', 'not_started');
      }
      if (request.references.length > references.length) downgrades.push('references_omitted');
      if (request.seed !== undefined) downgrades.push('seed_omitted');
      downgrades.push('idempotency_unavailable');

      const image = await adapter.paint({ prompt, references, quality: request.target.quality });
      return {
        provider,
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
      try {
        const response = await fetchImpl(keyCheck.url, {
          headers: keyCheck.headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
        });
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
