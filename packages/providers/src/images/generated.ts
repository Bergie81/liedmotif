import { OPENROUTER_DEFAULT_COVER_MODEL } from '@liedmotif/shared';
import { ProviderConfigError } from '../errors';
import { readBoundedResponseJson } from '../validation/response-limit';
import { pinnedProviderFetch } from '../validation/provider-fetch';
import { assertAllowedBaseUrl } from '../validation/ssrf';
import {
  COVER_IMAGE_MEDIA_TYPES,
  GeneratedImageProviderError,
  type CoverImageMediaType,
  type GeneratedImageCapabilities,
  type GeneratedImageCapabilityDowngrade,
  type GeneratedImageProvider,
  type GeneratedImageReference,
} from './generated-image-contract';
import {
  assertionDescriptor,
  intersectDescriptor,
  parseEndpointDescriptor,
  type EndpointDescriptor,
  type OpenRouterImageCapabilityAssertion,
  type OpenRouterImageParam,
} from './openrouter-image-capabilities';

export {
  OPENROUTER_IMAGE_PARAMS,
  parseOpenRouterImageParams,
  type OpenRouterImageCapabilityAssertion,
  type OpenRouterImageParam,
} from './openrouter-image-capabilities';
export {
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
} from './generated-image-contract';

export { OPENROUTER_DEFAULT_COVER_MODEL };
export const OPENROUTER_IMAGES_BASE_URL = 'https://openrouter.ai/api/v1';

const DEFAULT_TIMEOUT_MS = 60_000;
/** How long an outage fallback is reused before the next cover probes again.
 *  Long enough that a sustained outage costs one probe per window rather than one
 *  per cover, short enough that a blip costs only the covers inside it. */
export const DISCOVERY_RETRY_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_RESOLUTION = '1K';
const DEFAULT_ASPECT_RATIO = '1:1';
/**
 * Reference byte cap applied when capability discovery is unavailable and the
 * operator assertion declares reference support without a byte limit. Without
 * it the cap silently disappears on fallback and a large photo rides into the
 * JSON body unbounded (base64 + stringify ≈ 4× its size held across the
 * request await).
 */
export const FALLBACK_MAX_REFERENCE_BYTES = 4 * 1024 * 1024;

/**
 * Ceiling on the generation response itself. The artwork comes back base64
 * INSIDE the JSON, so the body is the fat thing and nothing downstream can bound
 * it: a `response.json()` has already materialized whatever arrived. Sized well
 * above a large cover once base64 has grown it by a third.
 */
const MAX_IMAGE_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface OpenRouterImageConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  resolution?: string;
  aspectRatio?: string;
  requestTimeoutMs?: number;
  capabilityAssertion?: OpenRouterImageCapabilityAssertion;
  supportedParams?: readonly OpenRouterImageParam[];
  fetch?: typeof globalThis.fetch;
}

interface CapabilityResolution {
  capabilities: GeneratedImageCapabilities;
  conservative: boolean;
  supportedParameters: Set<OpenRouterImageParam>;
  providerTag?: string;
  assertionFallback: boolean;
  acceptedValues: Partial<Record<OpenRouterImageParam, Set<string>>>;
}

interface OpenRouterImageDatum {
  id?: unknown;
  b64_json?: unknown;
  mime_type?: unknown;
  media_type?: unknown;
  url?: unknown;
}
function capabilitiesFromDescriptor(
  descriptor: EndpointDescriptor | null,
  provider: GeneratedImageCapabilities['provider'],
): GeneratedImageCapabilities {
  const supported = descriptor?.supportedParameters ?? new Set<OpenRouterImageParam>();
  const reference = supported.has('input_references') ? descriptor?.referenceLimits : null;
  const references =
    reference && reference.maxCount && reference.roles && reference.mediaTypes
      ? {
          roles: reference.roles,
          maxCount: reference.maxCount,
          multiSubjectIdentity: reference.multiSubjectIdentity === true,
          mediaTypes: reference.mediaTypes,
          ...(reference.maxBytesPerReference
            ? { maxBytesPerReference: reference.maxBytesPerReference }
            : {}),
          ...(reference.maxTotalBytes ? { maxTotalBytes: reference.maxTotalBytes } : {}),
        }
      : null;
  return {
    provider,
    ...(descriptor?.maxPromptCharacters
      ? { maxPromptCharacters: descriptor.maxPromptCharacters }
      : {}),
    exclusions: supported.has('negative_prompt') ? 'native' : 'inline',
    nativeSeed: supported.has('seed'),
    idempotency: 'absent',
    references,
    squareOutput: supported.has('aspect_ratio') ? 'native' : 'local_crop',
    maxCandidates: supported.has('n') ? Math.max(1, descriptor?.maxCandidates ?? 1) : 1,
    costReporting: descriptor?.costReporting ?? false,
  };
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

/** See `FALLBACK_MAX_REFERENCE_BYTES` — applied only to fallback resolutions. */
function withFallbackReferenceCap(
  capabilities: GeneratedImageCapabilities,
): GeneratedImageCapabilities {
  if (!capabilities.references || capabilities.references.maxBytesPerReference) {
    return capabilities;
  }
  return {
    ...capabilities,
    references: {
      ...capabilities.references,
      maxBytesPerReference: FALLBACK_MAX_REFERENCE_BYTES,
    },
  };
}

function dataUrl({ bytes, mediaType }: GeneratedImageReference): string {
  // A Buffer VIEW over the existing bytes — `Buffer.from(Uint8Array)` would copy
  // megabytes per reference photo just to base64 them.
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return `data:${mediaType};base64,${view.toString('base64')}`;
}

function resolveMediaType(bytes: Uint8Array, declared: string | null): CoverImageMediaType {
  if (bytes.length >= 12) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
      return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    )
      return 'image/webp';
  }
  return declared && (COVER_IMAGE_MEDIA_TYPES as readonly string[]).includes(declared)
    ? (declared as CoverImageMediaType)
    : 'image/png';
}

function extractImage(
  datum: OpenRouterImageDatum,
): { bytes: Uint8Array; mediaType: CoverImageMediaType } | null {
  let bytes: Uint8Array | null = null;
  let declared: string | null = null;
  if (typeof datum.b64_json === 'string' && datum.b64_json.length > 0) {
    bytes = decodeBase64(datum.b64_json);
    declared =
      (typeof datum.mime_type === 'string' && datum.mime_type) ||
      (typeof datum.media_type === 'string' && datum.media_type) ||
      null;
  } else if (typeof datum.url === 'string') {
    const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(datum.url);
    if (match) {
      bytes = decodeBase64(match[2]!);
      declared = match[1]!;
    }
  }
  return bytes ? { bytes, mediaType: resolveMediaType(bytes, declared) } : null;
}

function safeOperationId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

function classifyStatus(status: number): GeneratedImageProviderError {
  if (status === 401 || status === 403)
    return new GeneratedImageProviderError('configuration', 'not_started');
  if (status === 429) return new GeneratedImageProviderError('rate_limit', 'not_started');
  if (status === 408 || status === 504)
    return new GeneratedImageProviderError('timeout', 'outcome_unknown');
  if (status === 404) return new GeneratedImageProviderError('configuration', 'not_started');
  if (status === 400 || status === 402 || status === 409 || status === 413 || status === 422)
    return new GeneratedImageProviderError('rejection', 'not_started');
  return new GeneratedImageProviderError('unavailable', 'outcome_unknown');
}

function acceptedReferences(
  references: GeneratedImageReference[],
  capabilities: GeneratedImageCapabilities,
): GeneratedImageReference[] {
  const limits = capabilities.references;
  if (!limits) return [];
  const accepted: GeneratedImageReference[] = [];
  let totalBytes = 0;
  for (const reference of references) {
    if (accepted.length >= limits.maxCount) break;
    if (!limits.roles.includes(reference.role) || !limits.mediaTypes.includes(reference.mediaType))
      continue;
    if (limits.maxBytesPerReference && reference.bytes.byteLength > limits.maxBytesPerReference)
      continue;
    if (limits.maxTotalBytes && totalBytes + reference.bytes.byteLength > limits.maxTotalBytes)
      continue;
    accepted.push(reference);
    totalBytes += reference.bytes.byteLength;
  }
  return accepted;
}

function assertSafeBaseUrl(baseUrl: string): void {
  try {
    assertAllowedBaseUrl('openrouter', baseUrl);
  } catch {
    throw new GeneratedImageProviderError('configuration', 'not_started');
  }
}

export function openRouterImageProvider(config: OpenRouterImageConfig): GeneratedImageProvider {
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new GeneratedImageProviderError('configuration', 'not_started');
  const baseUrl = (config.baseUrl?.trim() || OPENROUTER_IMAGES_BASE_URL).replace(/\/+$/, '');
  const model = config.model?.trim() || OPENROUTER_DEFAULT_COVER_MODEL;
  const resolution = config.resolution?.trim() || DEFAULT_RESOLUTION;
  const aspectRatio = config.aspectRatio?.trim() || DEFAULT_ASPECT_RATIO;
  const timeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = config.fetch ?? pinnedProviderFetch({ providerKey: 'openrouter' });
  const operatorAssertion = assertionDescriptor(config);
  const providerMetadata = { providerType: 'image' as const, providerKey: 'openrouter', model };
  let capabilityPromise: Promise<CapabilityResolution> | null = null;
  /** While `capabilityPromise` holds an outage fallback, the moment it stops being
   *  reused and the next cover probes again. `Infinity` for a live descriptor (kept
   *  for the process) and for an in-flight probe (always shared, never duplicated). */
  let reuseUntil = Infinity;
  const fallbackResolution = (): CapabilityResolution => ({
    capabilities: withFallbackReferenceCap(
      capabilitiesFromDescriptor(operatorAssertion, providerMetadata),
    ),
    conservative: operatorAssertion === null,
    supportedParameters: operatorAssertion?.supportedParameters ?? new Set(),
    assertionFallback: operatorAssertion !== null,
    acceptedValues: operatorAssertion?.acceptedValues ?? {},
  });

  /** Resolved WITHOUT a live descriptor — the operator assertion, else the
   *  conservative floor. Both mean discovery was unavailable, never that the
   *  model lacks the parameters. */
  const isDiscoveryFallback = (resolution: CapabilityResolution): boolean =>
    resolution.conservative || resolution.assertionFallback;

  const discover = async (): Promise<CapabilityResolution> => {
    if (capabilityPromise && Date.now() < reuseUntil) return capabilityPromise;
    reuseUntil = Infinity;
    capabilityPromise = (async () => {
      assertSafeBaseUrl(baseUrl);
      const segments = model.split('/');
      if (segments.length < 2 || segments.some((segment) => segment.length === 0)) {
        throw new GeneratedImageProviderError('configuration', 'not_started');
      }
      const path = segments.map(encodeURIComponent).join('/');
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/images/models/${path}/endpoints`, {
          headers: { authorization: `Bearer ${apiKey}` },
          redirect: 'manual',
          signal: AbortSignal.timeout(8_000),
        });
      } catch {
        return fallbackResolution();
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        throw new GeneratedImageProviderError('configuration', 'not_started');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return fallbackResolution();
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return fallbackResolution();
      }
      const discovered = parseEndpointDescriptor(payload);
      if (!discovered) {
        return fallbackResolution();
      }
      const effective = intersectDescriptor(discovered, operatorAssertion);
      if (!effective.acceptedValues.aspect_ratio?.has(aspectRatio)) {
        effective.supportedParameters.delete('aspect_ratio');
      }
      if (!effective.acceptedValues.resolution?.has(resolution)) {
        effective.supportedParameters.delete('resolution');
      }
      const candidateRange = effective.candidateRange;
      if (
        !candidateRange ||
        (candidateRange.min !== undefined && candidateRange.min > 1) ||
        (candidateRange.max !== undefined && candidateRange.max < 1)
      ) {
        effective.supportedParameters.delete('n');
      }
      return {
        capabilities: capabilitiesFromDescriptor(effective, providerMetadata),
        conservative: false,
        supportedParameters: effective.supportedParameters,
        providerTag: effective.providerTag,
        assertionFallback: false,
        acceptedValues: effective.acceptedValues,
      };
    })();
    const resolved = await capabilityPromise;
    // An outage is transient, so its fallback expires: pinning it would strip the
    // configured resolution and aspect ratio from every later cover until a
    // restart. The cooldown bounds the other side — a sustained outage costs one
    // probe timeout per window, not one per cover. A rejected key throws instead
    // of returning, keeping the failed promise cached against a permanent
    // `reuseUntil`: that failure is configuration and never heals on its own.
    if (isDiscoveryFallback(resolved)) reuseUntil = Date.now() + DISCOVERY_RETRY_COOLDOWN_MS;
    return resolved;
  };

  return {
    ...providerMetadata,

    async getCapabilities() {
      return (await discover()).capabilities;
    },

    async generate(request) {
      if (request.count !== 1) {
        throw new GeneratedImageProviderError('configuration', 'not_started');
      }
      const resolutionResult = await discover();
      const capabilities = resolutionResult.capabilities;
      const references = acceptedReferences(request.references, capabilities);
      const downgrades: GeneratedImageCapabilityDowngrade[] = [];
      if (resolutionResult.conservative) downgrades.push('capabilities_conservative');

      let prompt = request.positivePrompt;
      if (request.exclusions.length > 0 && capabilities.exclusions === 'inline') {
        prompt += `\n\nExclude: ${request.exclusions.join('; ')}.`;
        downgrades.push('exclusions_inlined');
      }
      if (capabilities.maxPromptCharacters && prompt.length > capabilities.maxPromptCharacters) {
        throw new GeneratedImageProviderError('rejection', 'not_started');
      }
      if (capabilities.squareOutput === 'local_crop') downgrades.push('square_requires_local_crop');
      if (!resolutionResult.supportedParameters.has('resolution'))
        downgrades.push('resolution_omitted');
      const qualityValue = request.target.quality === 'standard' ? 'auto' : 'high';
      const qualityAccepted =
        resolutionResult.assertionFallback ||
        resolutionResult.acceptedValues.quality?.has(qualityValue) === true;
      if (!resolutionResult.supportedParameters.has('quality') || !qualityAccepted) {
        downgrades.push('quality_omitted');
      }
      if (!resolutionResult.supportedParameters.has('n'))
        downgrades.push('candidate_count_omitted');
      if (request.references.length > references.length) downgrades.push('references_omitted');
      if (request.seed !== undefined && !capabilities.nativeSeed) downgrades.push('seed_omitted');
      if (capabilities.idempotency === 'absent') downgrades.push('idempotency_unavailable');

      const body: Record<string, unknown> = {
        model,
        prompt,
        ...(resolutionResult.providerTag
          ? { provider: { only: [resolutionResult.providerTag], allow_fallbacks: false } }
          : {}),
      };
      const supportedParameters = resolutionResult.supportedParameters;
      if (supportedParameters.has('resolution')) body.resolution = resolution;
      if (supportedParameters.has('aspect_ratio')) body.aspect_ratio = aspectRatio;
      if (supportedParameters.has('quality') && qualityAccepted) {
        body.quality = qualityValue;
      }
      if (supportedParameters.has('negative_prompt') && request.exclusions.length > 0) {
        body.negative_prompt = request.exclusions.join('; ');
      }
      if (supportedParameters.has('n')) body.n = 1;
      if (supportedParameters.has('seed') && request.seed !== undefined) body.seed = request.seed;
      if (supportedParameters.has('input_references') && references.length > 0) {
        body.input_references = references.map((reference) => ({
          type: 'image_url',
          image_url: { url: dataUrl(reference) },
        }));
      }

      assertSafeBaseUrl(baseUrl);
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/images`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // A refused dial (the host resolved somewhere it may not be reached)
        // never left the process, so it is provably a not-started configuration
        // failure rather than an ambiguous one the caller must treat as spend.
        if (error instanceof ProviderConfigError) {
          throw new GeneratedImageProviderError('configuration', 'not_started');
        }
        const timedOut = error instanceof Error && error.name === 'TimeoutError';
        throw new GeneratedImageProviderError(
          timedOut ? 'timeout' : 'unavailable',
          'outcome_unknown',
        );
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw classifyStatus(response.status);
      }

      let payload: unknown;
      try {
        payload = await readBoundedResponseJson(response, MAX_IMAGE_RESPONSE_BYTES);
      } catch {
        throw new GeneratedImageProviderError('invalid_response', 'outcome_unknown');
      }
      const data = (payload as { data?: unknown }).data;
      const datum = Array.isArray(data) ? (data[0] as OpenRouterImageDatum | undefined) : undefined;
      const image = datum ? extractImage(datum) : null;
      if (!image) throw new GeneratedImageProviderError('invalid_response', 'outcome_unknown');
      const reportedCost = (payload as { usage?: { cost?: unknown } }).usage?.cost;
      const operationId =
        safeOperationId((payload as { id?: unknown }).id) ?? safeOperationId(datum?.id);
      return {
        provider: providerMetadata,
        ...image,
        ...(operationId ? { operationId } : {}),
        ...(typeof reportedCost === 'number' && Number.isFinite(reportedCost) && reportedCost >= 0
          ? { reportedCostUsd: reportedCost }
          : {}),
        appliedControls: {
          exclusions: capabilities.exclusions,
          square: capabilities.squareOutput,
          references: references.length,
          seed: request.seed !== undefined && capabilities.nativeSeed,
          idempotency: capabilities.idempotency,
          candidateCount: 1,
        },
        downgradeCodes: downgrades,
      };
    },

    async validateCredentials() {
      try {
        // The endpoints listing discovery reads answers any key; the key's own
        // metadata endpoint is the free read that refuses a wrong one.
        assertSafeBaseUrl(baseUrl);
        const keyResponse = await fetchImpl(`${baseUrl}/key`, {
          headers: { authorization: `Bearer ${apiKey}` },
          redirect: 'manual',
          signal: AbortSignal.timeout(8_000),
        });
        await keyResponse.body?.cancel().catch(() => undefined);
        if (!keyResponse.ok) {
          return { ok: false, message: 'Image provider credentials or endpoint were rejected.' };
        }
        await discover();
        return { ok: true, message: 'Image provider credentials and endpoint look valid.' };
      } catch {
        return { ok: false, message: 'Image provider credentials or endpoint were rejected.' };
      }
    },
  };
}
