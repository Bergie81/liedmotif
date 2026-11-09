import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Every relaxation here is load-bearing against a shipped feature, checked
 * against real usage: `script-src 'unsafe-inline'` for the theme bootstrap and
 * Next's inline RSC payloads, `style-src 'unsafe-inline'` for React and Radix,
 * `img-src blob:` for crop previews and offline covers, `media-src blob:` for
 * the voice-setup WAV preview and offline audio (object URLs over the device's
 * offline store). Nonce-based CSP is the stricter follow-up; `worker-src 'self'`
 * names the service worker apart from `script-src`, so that tightening cannot
 * block its registration.
 *
 * `unsafe-eval` is added for the DEV SERVER ONLY — its hot-reload runtime
 * evaluates module code, so an enforcing policy without it breaks `npm run dev`.
 * That is the one difference from the Caddyfile copy, which only ever fronts a
 * production build. Exported so a test can hold both branches to the rule.
 *
 * `report-uri` rather than `report-to`: it needs no companion
 * `Reporting-Endpoints` header and every engine that ships CSP honours it, so
 * the app route sees reports from all of them.
 */
export function contentSecurityPolicyFor(nodeEnv) {
  const scriptSrc =
    nodeEnv === 'development'
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : "script-src 'self' 'unsafe-inline'";
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "worker-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'report-uri /api/csp-report',
  ].join('; ');
}

const contentSecurityPolicy = contentSecurityPolicyFor(process.env.NODE_ENV);

/**
 * Defense-in-depth response headers, mirrored in the Caddyfile site block so a
 * `npm run dev` origin behaves like the proxied one — edit both together.
 *
 * The policy ships twice: enforcing, and Report-Only alongside it. The
 * Report-Only copy is where a tightening (a nonce-based `script-src`) soaks
 * against real traffic before it replaces the enforced one — both report to
 * `/api/csp-report`, and each report says which disposition produced it.
 * `microphone=(self)` must stay `self` — voice recording and voice input depend
 * on it. HSTS is inert on a bare-IP origin but required the moment a real
 * hostname is served.
 */
const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  { key: 'Content-Security-Policy-Report-Only', value: contentSecurityPolicy },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'microphone=(self), camera=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The browser audio harness reaches the dev server through IPv4 loopback.
  allowedDevOrigins: ['127.0.0.1'],
  headers: async () => [{ source: '/:path*', headers: securityHeaders }],
  // Caddy owns response compression (zstd/gzip). Compressing in the Node
  // process would spend app CPU next to the audio streams and defeat Caddy's
  // negotiation with an already-gzipped body.
  compress: false,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  // Covers and avatars are private, owner-authorized bytes served by app
  // routes; the image optimizer must never fetch them. Global instead of
  // per-callsite so the invariant is structural.
  images: { unoptimized: true },
  experimental: {
    // Back-navigation within this window replays the router cache instead of
    // a cold load. If a mutation must be visible on back-nav sooner, the fix
    // is a targeted `router.refresh()` after it, not removing the cache.
    staleTimes: { dynamic: 15 },
    // Dev-only: the browser harness loads the Offline Library with the network
    // cut, and a dev page hydrates only once React's debug channel answers over
    // the HMR socket, which cannot connect offline.
    ...(process.env.LIEDMOTIF_BROWSER_HARNESS === '1' ? { reactDebugChannel: false } : {}),
  },
  // The player polls the queue every few seconds; keep the dev request log
  // readable by hiding that steady-state chatter (errors still log).
  logging: {
    incomingRequests: {
      ignore: [/^\/api\/sessions\/queue/],
    },
  },
  // Standalone output for a small, self-contained Docker runtime image.
  output: 'standalone',
  // Trace files from the monorepo root so workspace packages are bundled in.
  outputFileTracingRoot: path.join(dirname, '..', '..'),
  // Consume workspace packages as TypeScript source (source-first strategy).
  transpilePackages: [
    '@liedmotif/shared',
    '@liedmotif/db',
    '@liedmotif/providers',
    '@liedmotif/media',
  ],
  // Bundled assets are read from disk at request time, so tracing cannot infer
  // them from the import graph: name them for the routes that read them.
  outputFileTracingIncludes: {
    '/api/sessions/cover/upload': ['../../packages/media/assets/branding/*'],
    '/api/covers/[id]': ['../../packages/db/assets/covers/*'],
    '/api/setup': ['../../packages/db/assets/covers/*'],
    '/api/assistant': ['./docs-snapshot/**/*.md'],
  },
  // Test/tooling packages that tracing may pull into the standalone output.
  // sharp/@img stay traced — the covers route needs them at runtime.
  outputFileTracingExcludes: {
    '*': [
      '**/node_modules/typescript/**',
      '**/node_modules/@playwright/**',
      '**/node_modules/playwright-core/**',
      '**/node_modules/vitest/**',
      '**/node_modules/@vitest/**',
      '**/node_modules/esbuild/**',
      '**/node_modules/@esbuild/**',
      '**/node_modules/prettier/**',
      '**/node_modules/eslint/**',
    ],
  },
  // Keep these out of the server bundle; they are required at runtime and traced
  // into the standalone output. `pg` carries an optional Cloudflare-sockets shim;
  // `better-auth` has dynamic requires and a lazy `next/headers` import that are
  // happier left external than bundled.
  serverExternalPackages: ['pg', 'better-auth'],
};

export default nextConfig;
