// Connect-time IP pinning for provider-media fetches.
//
// Vetting a hostname and then handing the URL to `fetch` leaves resolve and
// connect non-atomic: the transport looks the name up a SECOND time, and a
// provider that answers a public address to the guard and a metadata/LAN
// address to the connection turns the media path into an exfiltration channel.
// Dialing only the addresses the guard already vetted closes that window, which
// also makes the guard's verdict memo harmless — a cached verdict can only
// authorize addresses it was itself computed from.
//
// The Host header and TLS SNI carry the original hostname, not the pinned
// address, which is what keeps a vhosted or signature-checking CDN answering.

import { isIP, type LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

/** `family` accepts the legacy string spellings alongside 4 / 6 / 0. */
function requestedFamily(family: number | 'IPv4' | 'IPv6' | undefined): number {
  if (family === 4 || family === 'IPv4') return 4;
  if (family === 6 || family === 'IPv6') return 6;
  return 0;
}

/**
 * A `lookup` implementation that ignores the hostname and answers with the
 * vetted addresses. An empty answer set (or a family the pin cannot satisfy)
 * fails the connection rather than falling back to DNS: no address means no
 * address, never "resolve it yourself".
 */
export function pinnedLookup(addresses: readonly string[]): LookupFunction {
  return (_hostname, options, callback) => {
    const entries = addresses
      .map((address) => ({ address, family: isIP(address) }))
      .filter((entry) => entry.family !== 0);
    const family = requestedFamily(options.family);
    const matching = family === 0 ? entries : entries.filter((entry) => entry.family === family);
    const first = matching[0];
    if (!first) {
      callback(new Error('no vetted address available for this host'), '', 0);
      return;
    }
    if (options.all) callback(null, matching);
    else callback(null, first.address, first.family);
  };
}

/**
 * Fetch `input`, connecting only to `addresses`.
 *
 * `undici`'s own `fetch` rather than the global one, deliberately: the
 * dispatcher is the whole point of the call, and a global `fetch` that a
 * framework has wrapped could drop an unknown init key — which would fail OPEN,
 * silently un-pinning the request. Same package, same Response semantics, no
 * such failure mode.
 *
 * The dispatcher is per call because the pin is: `close()` resolves once the
 * in-flight request — including a body still streaming to the caller — has
 * finished, so it is safe to start immediately and never truncates a download.
 */
export async function fetchPinnedAddresses(
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  addresses: readonly string[],
): Promise<Response> {
  const agent = new Agent({ connect: { lookup: pinnedLookup(addresses) } });
  let response: Response;
  try {
    // Two nominally distinct type worlds, one runtime: undici's fetch is the
    // implementation behind the platform's, and its Request/Response are the
    // platform classes. The casts cross the declaration gap, nothing else.
    response = (await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher: agent,
    })) as unknown as Response;
  } catch (error) {
    void agent.destroy().catch(() => undefined);
    throw error;
  }
  void agent.close().catch(() => undefined);
  return response;
}
