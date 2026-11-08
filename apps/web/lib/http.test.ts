import { describe, expect, it } from 'vitest';
import { clientIpFromHeaders } from './http';

// The rate-limit key seam. What matters is that the key is always a hop some
// TRUSTED proxy attested — never one the caller chose, which would make every
// limiter bypassable per request — and that one client is one bucket.

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe('clientIpFromHeaders', () => {
  it('keys on the hop the single trusted proxy appended', () => {
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': '203.0.113.7' }), 1)).toBe(
      '203.0.113.7',
    );
  });

  it('ignores forged entries the client sent to the left of the trusted hops', () => {
    // Caddy appends the address it saw; anything left of that is caller-supplied.
    const value = '9.9.9.9, 203.0.113.7';
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': value }), 1)).toBe('203.0.113.7');
  });

  it('keys on the true client hop behind two trusted proxies', () => {
    // client -> LB -> Caddy: the LB appended the client, Caddy appended the LB.
    const value = '203.0.113.7, 10.0.0.5';
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': value }), 2)).toBe('203.0.113.7');
  });

  it('still refuses a forged entry when two proxies are trusted', () => {
    const value = '9.9.9.9, 203.0.113.7, 10.0.0.5';
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': value }), 2)).toBe('203.0.113.7');
  });

  it('falls back to the last proxy-appended hop when the chain is shorter than configured', () => {
    // A request that bypassed the LB carries fewer hops; the rightmost entry is
    // still the one the closest proxy appended, so it is never caller-chosen.
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': '198.51.100.4' }), 3)).toBe(
      '198.51.100.4',
    );
  });

  it('keeps an IPv6 hop intact', () => {
    const value = '2001:db8::1';
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': value }), 1)).toBe('2001:db8::1');
  });

  it('strips the port some load balancers append, so one client is one bucket', () => {
    const first = clientIpFromHeaders(headers({ 'x-forwarded-for': '203.0.113.7:41001' }), 1);
    const second = clientIpFromHeaders(headers({ 'x-forwarded-for': '203.0.113.7:52334' }), 1);
    expect(first).toBe('203.0.113.7');
    expect(second).toBe(first);
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': '[2001:db8::1]:443' }), 1)).toBe(
      '2001:db8::1',
    );
  });

  it('skips blank entries rather than counting them as hops', () => {
    const value = ' , 203.0.113.7 , ';
    expect(clientIpFromHeaders(headers({ 'x-forwarded-for': value }), 1)).toBe('203.0.113.7');
  });

  it('falls back to x-real-ip, then to one shared bucket, without a forwarded chain', () => {
    expect(clientIpFromHeaders(headers({ 'x-real-ip': ' 203.0.113.7 ' }), 1)).toBe('203.0.113.7');
    // One named bucket, so callers arriving without either header are counted
    // together instead of each getting a fresh budget.
    expect(clientIpFromHeaders(headers({}), 1)).toBe('unknown');
  });

  it('ignores forwarding headers entirely when no proxy is trusted', () => {
    // Directly reachable app: both headers are attacker-controlled, so keying on
    // either would hand out a fresh limiter bucket per request.
    const forged = headers({ 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '8.8.8.8' });
    const other = headers({ 'x-forwarded-for': '9.9.9.10', 'x-real-ip': '8.8.8.9' });
    expect(clientIpFromHeaders(forged, 0)).toBe(clientIpFromHeaders(other, 0));
    expect(clientIpFromHeaders(forged, 0)).not.toBe('9.9.9.9');
  });
});
