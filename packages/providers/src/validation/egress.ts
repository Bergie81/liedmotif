// Egress guard for provider-RETURNED media URLs.
//
// The music provider hands back `streamAudioUrl` / `audioUrl` values that the app
// later fetches server-side (the audio stream proxy and `download-final-audio`).
// A malicious or compromised "compatible" provider could point those at internal,
// loopback, or cloud-metadata hosts — so every fetch of a provider media URL goes
// through here: https only (an escape hatch aside), the host must not be (or
// resolve to) a private address, the connection is PINNED to the addresses that
// check returned, and redirects are followed MANUALLY with every hop re-validated
// and re-pinned instead of trusting the provider's redirect chain.
//
// Errors are sanitized `ProviderEgressError`s — they never echo the (signed,
// secret-bearing) media URL.

import { ProviderEgressError } from '../errors';
import { fetchPinnedAddresses } from './pinned-fetch';
import { resolveVettedAddresses, systemResolve, type ResolveHostAddresses } from './ssrf';

/**
 * The transport a hop is dialed through. `addresses` are the vetted answers the
 * connection must be pinned to — a transport that resolves the hostname itself
 * reopens the rebinding window this guard exists to close.
 */
export type PinnedFetch = (
  url: string,
  init: RequestInit,
  addresses: readonly string[],
) => Promise<Response>;

export interface FetchProviderMediaOptions {
  /** Injectable so tests stream fixture bytes with zero network. */
  fetchImpl?: PinnedFetch;
  /** DNS resolution, injectable for tests (defaults to the system resolver). */
  resolve?: ResolveHostAddresses;
  /** Extra request headers (e.g. a forwarded `Range`). */
  headers?: Record<string, string>;
  /** Abort/timeout signal — the caller owns the time budget. */
  signal?: AbortSignal;
  /** Redirect-hop budget before giving up (default 5). */
  maxRedirects?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const BLOCKED_URL_MESSAGE = 'The provider returned a media URL that is not allowed.';

const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Memoized resolver verdicts (`hostname → the addresses it may be dialed at,
 * or null`). Media fetches hit the same provider CDN hosts on every cold-start
 * play; the memo halves resolver round trips without changing any verdict.
 *
 * A cached entry cannot widen the threat model: the connection is pinned to the
 * very addresses the cached verdict was computed from, so a rebinding answer
 * arriving inside the TTL is never dialed. The TTL stays short anyway — a stale
 * entry only costs a failed connection when a CDN legitimately moves.
 */
const VERDICT_TTL_MS = 30_000;
/** A hostile provider could spray hostnames; drop the memo rather than grow it. */
const VERDICT_CACHE_MAX_ENTRIES = 256;

interface CachedVerdict {
  addresses: string[] | null;
  expiresAt: number;
}

const systemResolverKey = {};
let verdictCaches = new WeakMap<object, Map<string, CachedVerdict>>();

export function resetEgressVerdictCacheForTests(): void {
  verdictCaches = new WeakMap();
}

/**
 * A verdict is only meaningful relative to the resolver that produced it, so
 * the memo is keyed by resolver identity: injected resolvers never share
 * entries with the system resolver or with each other. In production the
 * resolver is always the system one, so exactly one cache is long-lived.
 */
function verdictsFor(resolve: ResolveHostAddresses | undefined): Map<string, CachedVerdict> {
  const key: object = resolve ?? systemResolverKey;
  const cache = verdictCaches.get(key) ?? new Map<string, CachedVerdict>();
  verdictCaches.set(key, cache);
  return cache;
}

async function vettedAddressesMemoized(
  hostname: string,
  options: Pick<FetchProviderMediaOptions, 'resolve' | 'signal'>,
): Promise<string[] | null> {
  const cache = verdictsFor(options.resolve);
  const cached = cache.get(hostname);
  if (cached && Date.now() < cached.expiresAt) return cached.addresses;
  // The host check resolves DNS; the caller's signal bounds that wait too (an
  // abort surfaces as a transport-style rejection, not a "blocked" URL, and
  // is never cached).
  // A resolver that throws yields the same null as a blocked answer, but a DNS
  // blip is no verdict about the host: memoizing it would refuse a healthy CDN
  // to every caller for the whole TTL.
  let resolverFailed = false;
  const resolve = options.resolve ?? systemResolve;
  const addresses = await raceWithAbort(
    resolveVettedAddresses(hostname, {
      resolve: (host) =>
        resolve(host).catch((err: unknown) => {
          resolverFailed = true;
          throw err;
        }),
    }),
    options.signal,
  );
  if (resolverFailed) return addresses;
  if (cache.size >= VERDICT_CACHE_MAX_ENTRIES) cache.clear();
  cache.set(hostname, { addresses, expiresAt: Date.now() + VERDICT_TTL_MS });
  return addresses;
}

/**
 * Bound `promise` by an AbortSignal. `node:dns` lookups don't take a signal, so
 * without this a hostname delegated to dead nameservers would pin the caller
 * (request slot, worker lock) for the OS resolver's own timeout instead of the
 * caller's — the abort rejects the WAIT; the lookup itself is left to settle
 * in the background.
 */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

/**
 * Fetch a provider media URL with SSRF/egress validation on the URL AND on every
 * redirect target, connecting only to the addresses that validation vetted.
 * Returns the first non-redirect response (whatever its status — the caller
 * decides how to treat upstream errors). Throws a sanitized `ProviderEgressError`
 * for a blocked/unparseable URL or an exhausted redirect budget; transport errors
 * from the underlying fetch propagate unchanged.
 */
export async function fetchProviderMedia(
  url: string,
  options: FetchProviderMediaOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetchPinnedAddresses;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  // Provider media becomes a stored track, so on http a network MITM picks those
  // bytes — https is the default and the hatch exists for self-hosted mock or LAN
  // providers with no certificate. Read per call: deployment config, not a constant.
  const allowInsecure = process.env.ALLOW_INSECURE_PROVIDER_MEDIA === '1';

  let current = url;
  for (let hop = 0; ; hop += 1) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      throw new ProviderEgressError(BLOCKED_URL_MESSAGE);
    }
    // Every hop is checked, so a downgrade to http mid-chain is refused too.
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && allowInsecure)) {
      throw new ProviderEgressError(BLOCKED_URL_MESSAGE);
    }
    const addresses = await vettedAddressesMemoized(parsed.hostname, options);
    if (!addresses) {
      throw new ProviderEgressError(BLOCKED_URL_MESSAGE);
    }

    const response = await fetchImpl(
      current,
      {
        redirect: 'manual',
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
      addresses,
    );
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get('location');
    // Free the redirect response's connection before following.
    await response.body?.cancel().catch(() => undefined);
    if (!location || hop >= maxRedirects) {
      throw new ProviderEgressError(
        'The provider media URL redirected too many times or without a target.',
      );
    }
    // Relative Locations resolve against the CURRENT hop, then re-validate.
    current = new URL(location, parsed).toString();
  }
}
