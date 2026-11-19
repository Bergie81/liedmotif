// Server-startup validation (Next.js instrumentation hook — stable in Next 15).
// `register()` runs once when the server boots, BEFORE any request is served, so
// each setting below is proven while a bad value is still a failed deploy rather
// than a surprise on the request that first touches it. Every one of them would
// otherwise resolve lazily: `getAuthSecret()`, for instance, only when `getAuth()`
// first constructs the Better Auth instance — by which point public routes may
// already have rendered.
//
// The same hook owns this process's error boundaries: the handlers below and the
// `onRequestError` export are what put a route throw, a stray rejection and a
// fatal exception into the app's own structured, redacting logger.

import type { Instrumentation } from 'next';

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { createLogger, installProcessErrorHandlers } = await import('@liedmotif/shared');
    const {
      getAuthSecret,
      assertAccountEmailPosture,
      assertCaddyPortsPosture,
      assertInstanceAlertsPosture,
      assertPublicUrlPosture,
      trustedProxyHops,
    } = await import('./lib/env');
    const { assertStorageRootWritable, resolveStorageRuntimeConfig } =
      await import('@liedmotif/storage');
    const { configureSharpConcurrency } = await import('@liedmotif/media');
    const { adminExists, assertDatabaseUrlPosture, resolvePoolTuning } =
      await import('@liedmotif/db');
    const { encryptionKeyIfConfigured } = await import('@/lib/providers/credentials');
    const log = createLogger({ name: 'web' });
    // Installed before the checks below so anything they set in motion is
    // covered: a rejection that escapes a request handler must not be able to
    // take the server down without leaving a line behind.
    installProcessErrorHandlers({
      logError: (message, fields) => log.error(message, fields),
      exit: (code) => process.exit(code),
    });
    getAuthSecret();
    // Reaching a managed database in the clear, or with the password published
    // in this repository, is a deploy-time mistake — not something to discover
    // from a packet capture.
    assertDatabaseUrlPosture(process.env.DATABASE_URL ?? '');
    // Better Auth derives its secure-cookie behavior from APP_PUBLIC_URL, so a
    // wrong value here silently issues session cookies any network on the path
    // can read.
    assertPublicUrlPosture();
    // A real APP_DOMAIN that Caddy publishes on loopback is unreachable from
    // every other device, and nothing else says why.
    assertCaddyPortsPosture();
    // Half-configured account email would run with every mail flow silently
    // off; the SMTP server itself is only reached when a mail is sent.
    assertAccountEmailPosture();
    // Half-armed alerting would pass for health: nothing is sent, and nothing
    // says so until the Admin wonders why they never heard about a dead worker.
    assertInstanceAlertsPosture();
    // A half-configured instance must never silently write nowhere: `s3` selected
    // with required settings missing, or a `DATA_DIR` this process cannot write,
    // would otherwise surface on the first upload — or worse, only on the
    // deletes, which no-op against a wrong root while reporting success.
    await assertStorageRootWritable(resolveStorageRuntimeConfig());
    // A present-but-invalid key is otherwise a 500 on every route that touches a
    // stored credential — the worker already refuses to start on one.
    encryptionKeyIfConfigured();
    // Every rate limiter keys on the hop this count selects, so a typo here is a
    // security setting silently reading as its default — surface it at boot
    // rather than per request.
    trustedProxyHops();
    // The pool opens lazily on the first query, so without this a mistyped size
    // or timeout would surface as a 500 mid-traffic instead of a failed deploy.
    resolvePoolTuning('web');
    // Whether this instance is still claimable is a fact only the database
    // holds, so unlike the checks above it can fail — a database that is not up
    // yet must not fail the boot, it just leaves the posture unstated.
    try {
      const { unclaimedSetupWarning } = await import('./lib/auth/setup-token');
      const { getDb } = await import('@/lib/db');
      const warning = unclaimedSetupWarning(await adminExists(getDb()));
      if (warning) console.warn(warning);
    } catch {
      // Unreachable database: the wizard and the health check both surface it.
    }
    // The web process runs many small renditions at once (avatar crops, cover
    // tiles) — one libvips thread per operation keeps N concurrent renders from
    // spawning N per-core thread pools.
    configureSharpConcurrency(1);
    // Next's default SIGTERM handler exits immediately, cutting in-flight audio
    // streams and never draining the pool. When the image opts into manual
    // signal handling, own the shutdown: drain in-flight, then close the pool.
    // Resolve the grace here too, so a malformed value fails the deploy.
    if (process.env.NEXT_MANUAL_SIG_HANDLE) {
      const { closeWebPool } = await import('@/lib/db');
      const { drainWebProcess, installWebSignalHandlers, resolveShutdownGraceMs } =
        await import('./lib/shutdown');
      const graceMs = resolveShutdownGraceMs();
      installWebSignalHandlers({
        forceExit: (code) => process.exit(code),
        log: (message) => log.info(message),
        drain: () =>
          drainWebProcess({
            graceMs,
            wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            closePool: closeWebPool,
            exit: (code) => process.exit(code),
            log: (message) => log.info(message),
          }),
      });
    }
  }
}

/**
 * Errors Next catches on a route, render, or action — a bare 500 the app's own
 * logs would otherwise never mention. Only bounded, non-identifying fields are
 * logged: the request path can carry an invite or reset token and the headers
 * carry the session cookie, so a line gets the parameterized route pattern.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  // The edge runtime has no stdout for the structured logger to write to.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { createLogger } = await import('@liedmotif/shared');
  createLogger({ name: 'web' }).error('request failed', {
    err: error,
    method: request.method,
    routePath: context.routePath,
    routeType: context.routeType,
  });
};
