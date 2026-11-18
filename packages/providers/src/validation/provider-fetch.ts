// Connect-time IP pinning for the calls the adapters make to a provider's own
// API — LLM generation and its credential probe, image generation.
//
// The base URL is admin-configurable, and the literal `assertAllowedBaseUrl`
// gate each adapter runs first is zero-I/O by design: a hostname that resolved
// to a public address when it was SAVED can answer `169.254.169.254` or a LAN
// address by the time a call goes out. Resolving immediately before the dial and
// connecting only to the addresses that check vetted closes that window — the
// same guarantee `egress.ts` gives provider-RETURNED media URLs. The Host header
// and TLS SNI still carry the hostname, so a vhosted provider is unaffected.

import { ProviderConfigError, ProviderUnbilledError } from '../errors';
import { fetchPinnedAddresses } from './pinned-fetch';
import {
  allowsSameMachineHost,
  BLOCKED_BASE_URL_MESSAGE,
  resolveVettedAddresses,
  type ResolveHostAddresses,
} from './ssrf';

export interface PinnedProviderFetchOptions {
  /** The preset whose egress policy applies (see `allowsSameMachineHost`). */
  providerKey: string;
  /** DNS resolution, injectable for tests (defaults to the system resolver). */
  resolve?: ResolveHostAddresses;
}

/** The URL a `fetch` argument addresses, whichever of its forms it takes. */
function targetUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** The one wording for a provider host whose name did not resolve. */
export const PROVIDER_UNREACHABLE_MESSAGE =
  'The provider could not be reached. Try again in a moment.';

/**
 * A `fetch` for string or URL targets that vets the target address set and then
 * dials only it, throwing a sanitized `ProviderConfigError` when the host is (or
 * resolves to) a private/metadata address. A lookup that fails or answers
 * nothing throws a `ProviderUnbilledError` with the `provider_unavailable`
 * refusal instead: nothing was sent, nothing is misconfigured, and a later call
 * may resolve. Its Response is undici's, not the platform class (see
 * `fetchPinnedAddresses`).
 *
 * Resolution runs per call rather than through a verdict memo: these are API
 * calls seconds apart, not the media path's back-to-back byte fetches, so one
 * lookup each buys the freshest possible verdict for no measurable cost.
 */
export function pinnedProviderFetch(options: PinnedProviderFetchOptions): typeof fetch {
  return async (input, init) => {
    let hostname: string;
    try {
      hostname = new URL(targetUrl(input)).hostname;
    } catch {
      throw new ProviderConfigError(BLOCKED_BASE_URL_MESSAGE);
    }
    const addresses = await resolveVettedAddresses(hostname, {
      ...(options.resolve ? { resolve: options.resolve } : {}),
      allowSameMachine: allowsSameMachineHost(options.providerKey),
    });
    if (addresses === 'blocked') throw new ProviderConfigError(BLOCKED_BASE_URL_MESSAGE);
    if (addresses === 'unresolved') {
      throw new ProviderUnbilledError(
        PROVIDER_UNREACHABLE_MESSAGE,
        { lookupFailed: true },
        'provider_unavailable',
      );
    }
    return fetchPinnedAddresses(input, init ?? {}, addresses);
  };
}
