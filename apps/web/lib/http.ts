// Small request/response helpers for the API routes.

import { NextResponse } from 'next/server';
import { trustedProxyHops } from '@/lib/env';

/** The one bucket every caller shares when no forwarding header can be trusted. */
const SHARED_BUCKET = 'unknown';

/** `[2001:db8::1]` or `[2001:db8::1]:443` — the bracketed form, port optional. */
const BRACKETED_HOP = /^\[([^\]]+)\](?::\d+)?$/;

/**
 * `203.0.113.7:41001` — a port on an address carrying no colons of its own, so a
 * bare (unbracketed) IPv6 address keeps every colon it has.
 */
const HOP_WITH_PORT = /^([^:]+):\d+$/;

/**
 * One `x-forwarded-for` entry as a stable bucket key, or null when it is empty.
 * Some load balancers append `ip:port`; the port changes per connection, so
 * leaving it in would hand every request its own limiter bucket.
 */
function normalizeHop(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = BRACKETED_HOP.exec(trimmed) ?? HOP_WITH_PORT.exec(trimmed);
  return match ? match[1]! : trimmed;
}

/**
 * Best-effort client IP for rate-limiting. Each proxy APPENDS the address it
 * received from, so with `hops` trusted proxies in front, the client is the
 * entry `hops` from the right — the entries left of it are caller-supplied and
 * trivially spoofable, and keying on one would let an attacker rotate the header
 * for a fresh bucket per request.
 *
 * A chain SHORTER than configured (a request that bypassed a proxy) keys on the
 * rightmost entry instead: that one was still appended by a proxy, so the key is
 * never caller-chosen. With no chain at all, `x-real-ip` then one shared bucket —
 * a missing header must cost the limit, not bypass it.
 *
 * At 0 hops the app is reachable directly and BOTH headers are attacker-
 * controlled, so both are ignored and every caller shares one bucket. Next gives
 * a route handler no access to the socket peer address, so that shared bucket is
 * the fail-closed floor: keep the app behind the proxy (compose binds web to
 * 127.0.0.1) and count the real chain in `TRUSTED_PROXY_HOPS`.
 */
export function clientIp(request: Request): string {
  return clientIpFromHeaders(request.headers);
}

/** `clientIp` for server components, which see `next/headers` instead of a Request. */
export function clientIpFromHeaders(headers: Headers, hops: number = trustedProxyHops()): string {
  if (hops < 1) return SHARED_BUCKET;
  const chain = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map(normalizeHop)
    .filter((hop): hop is string => hop !== null);
  if (chain.length === 0) return normalizeHop(headers.get('x-real-ip') ?? '') ?? SHARED_BUCKET;
  // Counting off the front of the chain means it is shorter than configured, so
  // the rightmost entry stands in — it is the one the closest proxy appended.
  return chain[chain.length - hops] ?? chain[chain.length - 1]!;
}

/** A 429 with a `Retry-After` (seconds) header from a rate-limit decision. */
export function tooManyRequests(retryAfterMs: number): NextResponse {
  const seconds = Math.ceil(retryAfterMs / 1000);
  return NextResponse.json(
    { ok: false, error: 'Too many requests. Please slow down.' },
    { status: 429, headers: { 'Retry-After': String(seconds) } },
  );
}

/** A 400 with a safe, user-facing message. */
export function badRequest(message: string): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status: 400 });
}

/** A 403 with a safe, user-facing message. */
export function forbidden(message: string): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status: 403 });
}
