// Suno cover-art adapter: the fallback `GeneratedImageProvider` used when no
// prompt-driven image provider is configured. Unlike OpenRouter, the provider's
// cover endpoint takes NO prompt — it derives ~2 PNG covers from an existing
// completed music task — so this adapter declares `musicTaskSource` and requires
// `GeneratedImageRequest.musicTaskId`; every other creative field of the request
// is deliberately ignored.
//
// Money & safety rules, mirroring the Suno music adapter:
//   - The API key rides in `Authorization` only; every thrown error is a
//     sanitized `GeneratedImageProviderError` (never a provider body or URL).
//   - One cover per music task, enforced provider-side: a duplicate submit
//     returns the EXISTING cover task id, which makes same-key retries safe
//     (`idempotency: 'recoverable'`).
//   - The endpoint is async (submit → poll `record-info` → download), so
//     `generate()` polls internally until the bounded budget elapses; a timeout
//     surfaces as a safely-retryable outcome-unknown failure.
//   - The API base URL is SSRF-gated and its calls dial only the addresses that
//     gate vetted; the provider-returned image URL is downloaded through the
//     egress guard (private/metadata hosts blocked, redirects re-validated, no
//     auth header forwarded).

import { ProviderConfigError } from '../errors';
import {
  isSunoEnvelope,
  SUNO_DEFAULT_BASE_URL,
  SUNO_DEFAULT_CALLBACK_URL,
  sunoEnvelopeTaskId,
} from '../music/suno-wire';
import { GeneratedImageProviderError } from './generated-image-contract';
import type {
  CoverImageMediaType,
  GeneratedImageCapabilities,
  GeneratedImageProvider,
  GeneratedImageRequest,
  GeneratedImageResult,
} from './generated-image-contract';
import type { ProviderValidationResult } from '../types';
import { fetchProviderMedia, type PinnedFetch } from '../validation/egress';
import { pinnedProviderFetch } from '../validation/provider-fetch';
import {
  ProviderResponseTooLargeError,
  readBoundedResponseBytes,
} from '../validation/response-limit';
import { assertAllowedBaseUrl, type ResolveHostAddresses } from '../validation/ssrf';

export interface SunoCoverImageConfig {
  /** Provider API key (server-side only; the same key as the music adapter). */
  apiKey: string;
  /** API base URL; override only for a compatible mirror. */
  baseUrl?: string;
  /**
   * The API REQUIRES a `callBackUrl` even though we poll `record-info`; we never
   * rely on the callback firing, so it defaults to a harmless placeholder.
   */
  callbackUrl?: string;
  /**
   * Injectable `fetch` for the API calls — tests pass a stub so no real call is
   * ever made. Unset, the calls dial only addresses the SSRF guard vetted.
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Transport for the provider-RETURNED image URL, which is a different trust
   * class from the API base URL: unset, the egress guard dials only the
   * addresses it vetted. Tests inject a stub.
   */
  fetchMedia?: PinnedFetch;
  /** Per-request timeout (ms) for every outbound call. */
  requestTimeoutMs?: number;
  /** Delay between `record-info` polls (ms). */
  pollIntervalMs?: number;
  /** Total poll budget (ms) before the attempt times out as safely retryable. */
  maxPollMs?: number;
  /** Injectable wait — tests resolve instantly. */
  sleep?: (ms: number) => Promise<void>;
  /** DNS resolution for the image-download egress guard, injectable for tests. */
  resolveHostAddresses?: ResolveHostAddresses;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
/**
 * Sized for a worker job-slot budget: real generations complete in ~75 s, so
 * 120 s gives headroom without pinning a slot for 4 minutes. On timeout the
 * attempt settles outcome-unknown and the safe retry resubmits under the same
 * key, which dedups to the SAME provider task and resumes polling it.
 */
const DEFAULT_MAX_POLL_MS = 120_000;

/** Hard ceiling on a downloaded cover image (the finalizer re-encodes anyway),
 *  enforced while the body streams so heap is bounded rather than reported on. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const PROVIDER_METADATA = {
  providerType: 'image' as const,
  providerKey: 'suno-cover',
  model: 'suno-cover',
};

const CAPABILITIES: GeneratedImageCapabilities = {
  provider: PROVIDER_METADATA,
  exclusions: 'inline',
  nativeSeed: false,
  idempotency: 'recoverable',
  references: null,
  squareOutput: 'local_crop',
  maxCandidates: 1,
  costReporting: false,
  musicTaskSource: { musicProviderKey: 'suno' },
};

const CREDIT_UNREACHABLE = 'Could not reach the music provider to verify credentials.';
const CREDIT_REJECTED = 'The music provider rejected these credentials.';

/** A failed submit without a returned task id, classified by HTTP status. */
function classifySubmitStatus(status: number): GeneratedImageProviderError {
  if (status === 401 || status === 403 || status === 404)
    return new GeneratedImageProviderError('configuration', 'not_started');
  // 405 and 430 are the provider's call-frequency refusals, which clear on retry.
  if (status === 429 || status === 405 || status === 430)
    return new GeneratedImageProviderError('rate_limit', 'not_started');
  if (status === 408 || status === 504)
    return new GeneratedImageProviderError('timeout', 'outcome_unknown');
  // 455 is the provider's maintenance window — transient, never a terminal
  // rejection of the request itself.
  if (status === 455) return new GeneratedImageProviderError('unavailable', 'outcome_unknown');
  if (status >= 400 && status < 500)
    return new GeneratedImageProviderError('rejection', 'not_started');
  // A 5xx may have created the task server-side; the provider dedups the music
  // task, so replaying under the same key is safe.
  return new GeneratedImageProviderError('unavailable', 'outcome_unknown');
}

function sniffMediaType(declared: string | null, bytes: Uint8Array): CoverImageMediaType {
  const normalized = declared?.split(';')[0]?.trim().toLowerCase();
  if (normalized === 'image/png' || normalized === 'image/jpeg' || normalized === 'image/webp') {
    return normalized;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    return 'image/webp';
  }
  return 'image/png';
}

export function sunoCoverImageProvider(config: SunoCoverImageConfig): GeneratedImageProvider {
  const apiKey = config.apiKey;
  const baseUrl = (config.baseUrl?.trim() || SUNO_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const callbackUrl = config.callbackUrl?.trim() || SUNO_DEFAULT_CALLBACK_URL;
  const fetchImpl = config.fetch ?? pinnedProviderFetch({ providerKey: 'suno-cover' });
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxPollMs = config.maxPollMs ?? DEFAULT_MAX_POLL_MS;
  const sleep =
    config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // A fixed attempt budget instead of wall-clock reads keeps the loop
  // deterministic under an injected instant `sleep`.
  const maxPollAttempts = Math.max(1, Math.ceil(maxPollMs / pollIntervalMs));

  function assertSafeBaseUrl(): void {
    try {
      assertAllowedBaseUrl('suno-cover', baseUrl);
    } catch {
      throw new GeneratedImageProviderError('configuration', 'not_started');
    }
  }

  function authHeaders(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${apiKey}`, accept: 'application/json', ...extra };
  }

  /** Submit the cover task; a duplicate submit yields the EXISTING task id. */
  async function submitCover(musicTaskId: string): Promise<string> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/api/v1/suno/cover/generate`, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ taskId: musicTaskId, callBackUrl: callbackUrl }),
        redirect: 'manual',
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      // A refused dial (the host resolved somewhere it may not be reached) never
      // left the process, so unlike a transport failure it is provably a
      // not-started configuration problem.
      if (error instanceof ProviderConfigError) {
        throw new GeneratedImageProviderError('configuration', 'not_started');
      }
      // The POST may or may not have landed; the provider-side dedup makes a
      // same-key replay safe.
      throw new GeneratedImageProviderError('unavailable', 'outcome_unknown');
    }
    // The duplicate-cover refusal (400/409) carries the existing task id in the
    // body, so the body is parsed regardless of HTTP status.
    const payload = await response.json().catch(() => undefined);
    const coverTaskId = sunoEnvelopeTaskId(payload);
    if (coverTaskId) return coverTaskId;
    if (!response.ok) throw classifySubmitStatus(response.status);
    // The API also refuses under HTTP 200, mirroring HTTP's numbers in the
    // envelope code (429 out of credits, 455 maintenance).
    const envelopeCode = isSunoEnvelope(payload) ? payload.code : undefined;
    if (typeof envelopeCode === 'number' && envelopeCode >= 400) {
      throw classifySubmitStatus(envelopeCode);
    }
    throw new GeneratedImageProviderError('invalid_response', 'outcome_unknown');
  }

  /** One `record-info` read; `null` means "not decidable yet, keep polling". */
  async function readCoverRecord(coverTaskId: string): Promise<string[] | null> {
    let response: Response;
    try {
      response = await fetchImpl(
        `${baseUrl}/api/v1/suno/cover/record-info?taskId=${encodeURIComponent(coverTaskId)}`,
        {
          method: 'GET',
          headers: authHeaders(),
          redirect: 'manual',
          signal: AbortSignal.timeout(requestTimeoutMs),
        },
      );
    } catch {
      return null;
    }
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) return null;
    const data = isSunoEnvelope(payload) ? payload.data : undefined;
    if (typeof data !== 'object' || data === null) return null;
    const record = data as { successFlag?: unknown; response?: { images?: unknown } | null };
    // successFlag: 0 pending, 2 in progress, 1 success, 3 failed.
    if (record.successFlag === 3) {
      throw new GeneratedImageProviderError('rejection', 'outcome_unknown');
    }
    if (record.successFlag !== 1) return null;
    const images = Array.isArray(record.response?.images)
      ? record.response.images.filter(
          (url): url is string => typeof url === 'string' && url.length > 0,
        )
      : [];
    if (images.length === 0) {
      throw new GeneratedImageProviderError('invalid_response', 'outcome_unknown');
    }
    return images;
  }

  async function pollForImages(coverTaskId: string): Promise<string[]> {
    // The attempt count alone does not bound the slot: each read may run its
    // full request timeout, so a slow record-info also ends at the wall-clock
    // budget (overshooting it by at most one read).
    const deadline = Date.now() + maxPollMs;
    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
      if (attempt > 0) {
        await sleep(pollIntervalMs);
        if (Date.now() >= deadline) break;
      }
      const images = await readCoverRecord(coverTaskId);
      if (images) return images;
    }
    // Same-key retries are safe: a resubmit dedups to this cover task.
    throw new GeneratedImageProviderError('timeout', 'outcome_unknown');
  }

  async function downloadImage(
    url: string,
  ): Promise<{ bytes: Uint8Array; mediaType: CoverImageMediaType }> {
    let response: Response;
    try {
      response = await fetchProviderMedia(url, {
        ...(config.fetchMedia ? { fetchImpl: config.fetchMedia } : {}),
        signal: AbortSignal.timeout(requestTimeoutMs),
        ...(config.resolveHostAddresses ? { resolve: config.resolveHostAddresses } : {}),
      });
    } catch {
      // Blocked/unparseable URL or an exhausted redirect budget — the provider
      // returned an image location we refuse to touch.
      throw new GeneratedImageProviderError('invalid_response', 'outcome_unknown');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new GeneratedImageProviderError('unavailable', 'outcome_unknown');
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedResponseBytes(response, MAX_IMAGE_BYTES);
    } catch (error) {
      // An over-long body is the provider answering wrongly, not being down —
      // the same verdict an empty one gets.
      throw new GeneratedImageProviderError(
        error instanceof ProviderResponseTooLargeError ? 'invalid_response' : 'unavailable',
        'outcome_unknown',
      );
    }
    if (bytes.byteLength === 0) {
      throw new GeneratedImageProviderError('invalid_response', 'outcome_unknown');
    }
    return { bytes, mediaType: sniffMediaType(response.headers.get('content-type'), bytes) };
  }

  return {
    providerType: 'image',
    providerKey: PROVIDER_METADATA.providerKey,
    model: PROVIDER_METADATA.model,

    async getCapabilities(): Promise<GeneratedImageCapabilities> {
      return CAPABILITIES;
    },

    async generate(request: GeneratedImageRequest): Promise<GeneratedImageResult> {
      assertSafeBaseUrl();
      const musicTaskId = request.musicTaskId?.trim();
      if (!musicTaskId) {
        throw new GeneratedImageProviderError('configuration', 'not_started');
      }
      const coverTaskId = await submitCover(musicTaskId);
      const images = await pollForImages(coverTaskId);
      const { bytes, mediaType } = await downloadImage(images[0]!);
      return {
        provider: PROVIDER_METADATA,
        bytes,
        mediaType,
        operationId: coverTaskId,
        appliedControls: {
          exclusions: 'inline',
          square: 'local_crop',
          references: 0,
          seed: false,
          idempotency: 'recoverable',
          candidateCount: 1,
        },
        downgradeCodes: [],
      };
    },

    async validateCredentials(): Promise<ProviderValidationResult> {
      try {
        assertAllowedBaseUrl('suno-cover', baseUrl);
      } catch (err) {
        // A blocked base URL is a configuration problem, not a credential one —
        // report the sanitized config message (mirrors the music adapter).
        if (err instanceof ProviderConfigError) return { ok: false, message: err.message };
        throw err;
      }
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/api/v1/generate/credit`, {
          method: 'GET',
          headers: authHeaders(),
          redirect: 'manual',
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch {
        return { ok: false, message: CREDIT_UNREACHABLE };
      }
      const payload = await response.json().catch(() => undefined);
      if (
        response.ok &&
        isSunoEnvelope(payload) &&
        payload.code === 200 &&
        typeof payload.data === 'number'
      ) {
        return {
          ok: true,
          balance: payload.data,
          message: `Music provider reachable; ${payload.data} credits available.`,
        };
      }
      return { ok: false, message: CREDIT_REJECTED };
    },
  };
}
