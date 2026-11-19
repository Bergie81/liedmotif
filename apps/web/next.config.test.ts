import { describe, expect, it } from 'vitest';
import nextConfig, { contentSecurityPolicyFor } from './next.config.mjs';

// The response header set is defense-in-depth for the XSS bug nobody has found
// yet, so it is asserted here rather than left to a browser check: every
// relaxation in the policy is load-bearing against a shipped feature, and a
// tightening that reads as harmless silently breaks voice recording or the crop
// preview instead of failing a build.

const rules = await nextConfig.headers!();
const rule = rules[0]!;
const headers = Object.fromEntries(rule.headers.map((h) => [h.key, h.value]));

describe('next config security headers', () => {
  it('applies one set to every path', () => {
    expect(rules).toHaveLength(1);
    expect(rule.source).toBe('/:path*');
  });

  it('enforces the policy, with a Report-Only twin, both reporting', () => {
    // A policy with nowhere to report is a policy nobody can act on, and the
    // twin is what a future tightening soaks in.
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(headers['Content-Security-Policy']).toContain('report-uri /api/csp-report');
    expect(headers['Content-Security-Policy-Report-Only']).toBe(headers['Content-Security-Policy']);
  });

  it('keeps `unsafe-eval` to the dev server, which is the only thing that evals', () => {
    expect(contentSecurityPolicyFor('development')).toContain("'unsafe-eval'");
    expect(contentSecurityPolicyFor('production')).not.toContain('unsafe-eval');
  });

  it('keeps the CSP relaxations the app depends on', () => {
    const csp = headers['Content-Security-Policy']!;
    // Theme bootstrap script + Next's inline RSC payload scripts.
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    // React and Radix inline styles.
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    // Crop-preview object URLs.
    expect(csp).toContain("img-src 'self' blob:");
    // Same-origin audio plus the voice-setup WAV preview.
    expect(csp).toContain("media-src 'self' blob:");
  });

  it('lets the Offline Library play from the device and run its service worker, nothing more', () => {
    const csp = headers['Content-Security-Policy']!;
    // Offline audio and covers are object URLs over the device's offline store.
    expect(csp).toContain("media-src 'self' blob:");
    expect(csp).toContain("img-src 'self' blob:");
    // The service worker is a same-origin script, named apart from `script-src`
    // so a nonce-based tightening there cannot stop its registration.
    expect(csp).toContain("worker-src 'self';");
    // Nothing the offline page does fetches an object URL or a foreign origin.
    expect(csp).toContain("connect-src 'self';");
    expect(csp).toContain("default-src 'self';");
  });

  it('enforces the rest, with the microphone left to the app', () => {
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['X-Frame-Options']).toBe('DENY');
    // Voice recording (Settings → My voice) stops working the moment this is `()`.
    expect(headers['Permissions-Policy']).toBe('microphone=(self), camera=(), geolocation=()');
    expect(headers['Strict-Transport-Security']).toBe('max-age=31536000');
  });
});

describe('next config compression', () => {
  it('leaves compression to Caddy, so Next never encodes a route response', () => {
    // With `compress` on, Next gzips JSON and text route responses in the Node
    // process, next to the audio streams. Caddy's `encode` owns that instead.
    expect(nextConfig.compress).toBe(false);
  });
});
