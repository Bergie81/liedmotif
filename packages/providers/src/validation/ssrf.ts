// SSRF guard for the setup-validation endpoint, which fetches an admin-supplied
// base URL. During first-run setup that endpoint is unauthenticated (only
// rate-limited), so a caller could otherwise point it at internal hosts or the
// cloud metadata endpoint.
//
// This blocks non-globally-routable hosts (loopback / unspecified / link-local /
// private / CGNAT / documentation / multicast / IPv4-mapped / metadata) for the
// remote presets, while allowing loopback for Ollama (which legitimately runs on
// the same machine — localhost, or `host.docker.internal` from a container).
// Two layers exist:
//
// - The SYNC literal checks (`isBlockedValidationTarget` / `assertAllowedBaseUrl`)
//   catch IP-literal and well-known-name targets with zero I/O. The adapters call
//   these before every outbound fetch.
// - The ASYNC resolved checks (`isBlockedResolvedHost` /
//   `isBlockedValidationTargetResolved`) additionally RESOLVE hostnames and
//   reject any that map to a blocked address (DNS rebinding). These run at every
//   point where a base URL ENTERS the system — the setup-validation probe and
//   both credential-save routes (`/api/setup`, `/api/settings/credentials`).
//
// The pinned paths then close the resolve-then-connect window by dialing only
// the addresses `resolveVettedAddresses` just returned, so the transport never
// resolves the name a second time: provider-RETURNED media URLs through the
// egress guard (`egress.ts`), the LLM and image adapters' API calls through
// `provider-fetch.ts`. There, a name that was public when the admin saved it and
// is rebound to a private address afterwards is refused at dial time. The music
// adapters (`suno.ts`, `suno-voice.ts`) and the setup-validation probe are NOT
// pinned: they dial through the platform fetch after the literal / entry-time
// resolved checks, so a later rebind of their admin-configured host is not caught.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ProviderConfigError } from '../errors';

function stripBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, '');
}

const IPV4_LITERAL = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Loopback hosts: localhost, 127.0.0.0/8, ::1, and IPv4-mapped loopback. */
export function isLoopbackHost(hostname: string): boolean {
  const host = stripBrackets(hostname.toLowerCase());
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.includes(':')) {
    const value = ipv6ToBigInt(host);
    if (value === null) return false;
    if (value === 1n) return true; // ::1
    // IPv4-mapped (::ffff:a.b.c.d): loopback when the embedded IPv4 is 127/8.
    if (value >> 32n === 0xffffn) return ((value >> 24n) & 0xffn) === 127n;
    return false;
  }
  if (IPV4_LITERAL.test(host)) return host.startsWith('127.');
  return false;
}

/**
 * Non-globally-routable IPv4 space, blocked as SSRF targets. Loopback, RFC1918,
 * CGNAT (100.64/10 — Tailscale device addresses live here, and the self-hosting
 * docs recommend Tailscale, so a tailnet neighbor is internal infrastructure),
 * link-local/metadata, IETF-reserved, documentation, benchmarking, and
 * multicast/reserved/broadcast (224.0.0.0/3).
 */
const BLOCKED_IPV4_CIDRS: Cidrs = [
  ['0.0.0.0', 8], // "this network" / unspecified
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT shared address space (incl. Tailscale)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local incl. 169.254.169.254 metadata
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1 (documentation)
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2 (documentation)
  ['203.0.113.0', 24], // TEST-NET-3 (documentation)
  ['224.0.0.0', 3], // multicast + reserved + broadcast (224.0.0.0–255.255.255.255)
];

/** Dotted-decimal IPv4 → uint32, or null when not a valid literal. */
function ipv4ToInt(host: string): number | null {
  if (!IPV4_LITERAL.test(host)) return null;
  let value = 0;
  for (const part of host.split('.')) {
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

type Cidrs = ReadonlyArray<readonly [string, number]>;

function ipv4Ranges(cidrs: Cidrs) {
  return cidrs.map(([base, prefix]) => {
    // Mask arithmetic in unsigned space (>>> 0) — JS bitwise ops are signed 32-bit.
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return [(ipv4ToInt(base)! & mask) >>> 0, mask] as const;
  });
}

/**
 * Non-global IPv6 space, blocked as SSRF targets (the IANA special-purpose
 * registry's non-global entries). IPv4-mapped and the NAT64/translation prefixes
 * are blocked WHOLESALE — an embedded IPv4, public or not, reaching the network
 * through a translator is indistinguishable from an internal hop.
 */
const BLOCKED_IPV6_CIDRS: Cidrs = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['::ffff:0:0', 96], // IPv4-mapped
  ['64:ff9b::', 96], // NAT64 well-known prefix
  ['64:ff9b:1::', 48], // NAT64 local-use (RFC 8215)
  ['100::', 64], // discard-only
  ['2001::', 23], // IETF special assignments (Teredo, benchmarking, ORCHID, …)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // ULA
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
];

/**
 * IPv6 literal → 128-bit value, or null when not parseable. Handles `::`
 * compression, an embedded IPv4 tail (`::ffff:127.0.0.1`), and strips a zone id
 * (`fe80::1%eth0`). Inputs arrive canonicalized (WHATWG URL / getaddrinfo), but
 * parsing numerically means textual variants can never dodge a range check.
 */
function ipv6ToBigInt(host: string): bigint | null {
  let addr = host;
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);

  // Embedded IPv4 tail → two trailing 16-bit groups.
  const lastColon = addr.lastIndexOf(':');
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    addr = `${addr.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + rest.length > 8) return null;
  const groups = [...head, ...Array(8 - head.length - rest.length).fill('0'), ...rest];

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

function ipv6Ranges(cidrs: Cidrs) {
  return cidrs.map(([base, prefix]) => {
    const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
    return [ipv6ToBigInt(base)! & mask, mask] as const;
  });
}

interface IpRanges {
  v4: ReturnType<typeof ipv4Ranges>;
  v6: ReturnType<typeof ipv6Ranges>;
}

/** Whether an IP literal falls in `ranges`; a hostname or unparseable input never does. */
function inIpRanges(host: string, ranges: IpRanges): boolean {
  if (host.includes(':')) {
    const value = ipv6ToBigInt(host);
    return value !== null && ranges.v6.some(([base, mask]) => (value & mask) === base);
  }
  const value = ipv4ToInt(host);
  return value !== null && ranges.v4.some(([base, mask]) => (value & mask) >>> 0 === base);
}

const BLOCKED_RANGES: IpRanges = {
  v4: ipv4Ranges(BLOCKED_IPV4_CIDRS),
  v6: ipv6Ranges(BLOCKED_IPV6_CIDRS),
};

/**
 * The name a container uses for the machine it runs on (Docker Desktop built-in;
 * `extra_hosts: host-gateway` on Linux), and the RFC1918 / ULA space Docker
 * answers it with. Reaching it is reaching the same host, so it shares the
 * loopback exemption.
 */
const DOCKER_HOST_NAME = 'host.docker.internal';
const DOCKER_HOST_RANGES: IpRanges = {
  v4: ipv4Ranges([
    ['10.0.0.0', 8],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
  ]),
  v6: ipv6Ranges([['fc00::', 7]]),
};

/** Whether `address`, answered for `hostname`, is the machine Liedmotif runs on. */
function isSameMachineAddress(hostname: string, address: string): boolean {
  if (isLoopbackHost(address)) return true;
  return hostname === DOCKER_HOST_NAME && inIpRanges(address, DOCKER_HOST_RANGES);
}

/** Host LITERALS that must not be reachable as SSRF targets. */
export function isPrivateHost(hostname: string): boolean {
  const host = stripBrackets(hostname.toLowerCase());
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  // Unparseable colon-bearing input fails CLOSED — a host we cannot classify
  // must not be fetched.
  if (host.includes(':') && ipv6ToBigInt(host) === null) return true;

  // A regular hostname (not an IP literal) is NOT resolved here — see the module note.
  return inIpRanges(host, BLOCKED_RANGES);
}

/**
 * The one place a preset is granted the loopback exemption. Ollama has it
 * because it legitimately runs on the same machine — localhost natively, or the
 * Docker host through `host.docker.internal`; every other preset reaching either
 * is a port-probe oracle.
 *
 * Accepted risk: the exemption lets the admin-only validation probe reach any
 * port on that machine. It is bounded by the documented "trusted setup network"
 * threat model above.
 */
export function allowsSameMachineHost(providerKey: string): boolean {
  return providerKey === 'ollama';
}

/**
 * Whether a validation request for `providerKey` at `baseUrl` should be refused.
 * Ollama is exempt ONLY for loopback literals; every other case — including a
 * non-loopback Ollama literal — is blocked when the host is private/metadata. A
 * name (`host.docker.internal` included) is left to the resolved check. An
 * unparseable URL is refused.
 */
export function isBlockedValidationTarget(
  providerKey: string,
  baseUrl: string | undefined,
): boolean {
  if (!baseUrl) return false; // no override → the preset's own (public) default is used
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    return true; // unparseable → refuse
  }
  if (allowsSameMachineHost(providerKey) && isLoopbackHost(hostname)) return false;
  return isPrivateHost(hostname);
}

/** Resolve a hostname to all its addresses. Injectable so tests never touch DNS. */
export type ResolveHostAddresses = (hostname: string) => Promise<string[]>;

export const systemResolve: ResolveHostAddresses = async (hostname) => {
  // `lookup` (getaddrinfo) is what fetch itself uses, so we vet the same answers
  // (including /etc/hosts entries) the actual connection would see.
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
};

export interface ResolvedHostCheckOptions {
  resolve?: ResolveHostAddresses;
  /** Treat the machine Liedmotif runs on — loopback, or what `host.docker.internal`
   *  answers — as allowed (the narrow Ollama exemption). */
  allowSameMachine?: boolean;
}

/**
 * What a host check found: the addresses to dial, a refusal because the host is
 * (or answers) a blocked address, or no answer at all.
 */
export type VettedAddresses = string[] | 'blocked' | 'unresolved';

/**
 * The addresses `hostname` may be connected to, `'blocked'` when it is or
 * resolves to a blocked address, or `'unresolved'` when the lookup failed or
 * answered nothing.
 *
 * IP literals are checked directly; names are resolved and EVERY returned
 * address is vetted, so a public hostname with one private answer (DNS
 * rebinding) is refused wholesale rather than filtered down to its safe
 * entries. A failed lookup says nothing about the host, so it is kept apart
 * from a blocked one: nothing can be dialed either way, and each caller decides
 * whether that is a refusal or a temporary outage.
 *
 * The returned set is what a caller must pin the connection to: vetting these
 * addresses and then letting the transport resolve again is the gap
 * (`pinned-fetch.ts`) closes.
 */
export async function resolveVettedAddresses(
  hostname: string,
  options: ResolvedHostCheckOptions = {},
): Promise<VettedAddresses> {
  const resolve = options.resolve ?? systemResolve;
  const host = stripBrackets(hostname.toLowerCase());
  const isBlockedAddress = (address: string) =>
    options.allowSameMachine && isSameMachineAddress(host, address)
      ? false
      : isPrivateHost(address);

  if (isIP(host)) return isBlockedAddress(host) ? 'blocked' : [host];

  // Non-IP well-known names (`localhost` etc.) are caught literally before DNS.
  if (isBlockedAddress(host)) return 'blocked';

  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    return 'unresolved';
  }
  if (addresses.length === 0) return 'unresolved';
  return addresses.some(isBlockedAddress) ? 'blocked' : addresses;
}

/**
 * Whether `hostname` is (or RESOLVES to) a private/link-local/metadata address —
 * the verdict half of `resolveVettedAddresses`, for callers that only decide
 * whether to proceed and never dial themselves. A name that does not resolve is
 * refused too: it cannot be vetted, so it is not let in.
 */
export async function isBlockedResolvedHost(
  hostname: string,
  options: ResolvedHostCheckOptions = {},
): Promise<boolean> {
  return !Array.isArray(await resolveVettedAddresses(hostname, options));
}

/**
 * The resolved (DNS-rebinding-aware) variant of `isBlockedValidationTarget`, for
 * the setup-validation route: same policy, but hostnames are resolved and every
 * address is vetted before the validation probe fetches anything.
 */
export async function isBlockedValidationTargetResolved(
  providerKey: string,
  baseUrl: string | undefined,
  resolve?: ResolveHostAddresses,
): Promise<boolean> {
  if (!baseUrl) return false; // no override → the preset's own (public) default is used
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    return true; // unparseable → refuse
  }
  return isBlockedResolvedHost(hostname, {
    ...(resolve ? { resolve } : {}),
    // The exemption extends to names RESOLVING to the same machine — same trust
    // boundary, hardened against rebinding to any other private host.
    allowSameMachine: allowsSameMachineHost(providerKey),
  });
}

/** The one refusal wording for a base URL that points somewhere it may not. */
export const BLOCKED_BASE_URL_MESSAGE =
  'The configured provider URL is not allowed (it points to a private or internal host).';

/**
 * Throw a sanitized `ProviderConfigError` if `baseUrl` is a blocked SSRF target
 * for `providerKey`. LLM adapters call this before ANY outbound fetch (credential
 * validation and generation) so a configurable base URL can never reach a private
 * or metadata host.
 */
export function assertAllowedBaseUrl(providerKey: string, baseUrl: string | undefined): void {
  if (isBlockedValidationTarget(providerKey, baseUrl)) {
    throw new ProviderConfigError(BLOCKED_BASE_URL_MESSAGE);
  }
}
