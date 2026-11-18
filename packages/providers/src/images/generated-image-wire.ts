// The wire rules every prompt-driven generated-image adapter shares: how a
// submission is sent and classified, how the artwork is read back, and which
// references fit the declared limits. Vendor endpoints and request bodies stay in
// the adapters.

import { ProviderConfigError } from '../errors';
import { readBoundedResponseJson } from '../validation/response-limit';
import {
  COVER_IMAGE_MEDIA_TYPES,
  GeneratedImageProviderError,
  type CoverImageMediaType,
  type GeneratedImageCapabilities,
  type GeneratedImageReference,
} from './generated-image-contract';

/**
 * Ceiling on the generation response itself. The artwork comes back base64
 * INSIDE the JSON, so the body is the fat thing and nothing downstream can bound
 * it: a `response.json()` has already materialized whatever arrived. Sized well
 * above a large cover once base64 has grown it by a third.
 */
const MAX_IMAGE_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface GeneratedImageDatum {
  id?: unknown;
  b64_json?: unknown;
  mime_type?: unknown;
  media_type?: unknown;
  url?: unknown;
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

export function referenceDataUrl({ bytes, mediaType }: GeneratedImageReference): string {
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

export function extractImage(
  datum: GeneratedImageDatum,
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

/** The first image of an OpenAI-style `{ data: [...] }` reply, else `invalid_response`. */
export function firstImageDatum(payload: unknown): GeneratedImageDatum {
  const data = (payload as { data?: unknown } | null)?.data;
  const datum = Array.isArray(data) ? (data[0] as GeneratedImageDatum | undefined) : undefined;
  if (!datum || typeof datum !== 'object') {
    throw new GeneratedImageProviderError('invalid_response', 'outcome_unknown');
  }
  return datum;
}

export function safeOperationId(value: unknown): string | undefined {
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

export function acceptedReferences(
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

/**
 * POST one generation as JSON and return the parsed reply, read under the
 * response ceiling. Every failure becomes a sanitized `GeneratedImageProviderError`
 * carrying whether the vendor may have started (and billed) the work; nothing from
 * the request or the reply rides along.
 */
export async function submitGeneratedImageRequest(
  fetchImpl: typeof fetch,
  url: string,
  { apiKey, body, timeoutMs }: { apiKey: string; body: unknown; timeoutMs: number },
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
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
    throw new GeneratedImageProviderError(timedOut ? 'timeout' : 'unavailable', 'outcome_unknown');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw classifyStatus(response.status);
  }
  try {
    return await readBoundedResponseJson(response, MAX_IMAGE_RESPONSE_BYTES);
  } catch {
    throw new GeneratedImageProviderError('invalid_response', 'outcome_unknown');
  }
}
