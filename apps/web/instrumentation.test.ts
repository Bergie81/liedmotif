import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The boot contract: an instance that is misconfigured in a way the app cannot
// safely paper over must fail at start, not on the request that first touches
// the broken setting. Each case here is a misconfiguration that used to surface
// as a 500 (or, for the storage root, as silently misdirected writes).

const VALID_KEY = Buffer.alloc(32, 7).toString('base64');

let dataRoot: string;

/**
 * A boot per case: the config helpers memoize (the encryption key most of all),
 * and a real boot always starts from an empty module graph.
 */
async function boot(): Promise<void> {
  vi.resetModules();
  const { register } = await import('./instrumentation');
  return register();
}

beforeEach(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), 'liedmotif-boot-'));
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  vi.stubEnv('BETTER_AUTH_SECRET', 'boot-test-secret-long-enough-to-pass-the-floor');
  vi.stubEnv('APP_PUBLIC_URL', 'http://localhost:2206');
  vi.stubEnv('APP_DOMAIN', 'localhost');
  vi.stubEnv('STORAGE_PROVIDER', 'local-fs');
  vi.stubEnv('DATA_DIR', dataRoot);
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', VALID_KEY);
  vi.stubEnv('TRUSTED_PROXY_HOPS', '');
  vi.stubEnv('WEB_DB_POOL_MAX', '');
  // Explicit rather than inherited from `.env`: the boot inspects this string's
  // posture, so a developer's own value must not decide what the case proves.
  vi.stubEnv('DATABASE_URL', 'postgres://liedmotif:boot-test@localhost:5432/liedmotif_boot');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dataRoot, { recursive: true, force: true });
});

describe('register', () => {
  it('boots a configured instance', async () => {
    await expect(boot()).resolves.toBeUndefined();
  });

  it('refuses a storage root it cannot write', async () => {
    vi.stubEnv('DATA_DIR', path.join(dataRoot, 'never-created'));
    await expect(boot()).rejects.toThrow(/DATA_DIR/);
  });

  it('refuses a relative storage root', async () => {
    vi.stubEnv('DATA_DIR', 'data');
    await expect(boot()).rejects.toThrow(/DATA_DIR/);
  });

  it('refuses an invalid encryption key', async () => {
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', 'not-a-32-byte-key');
    await expect(boot()).rejects.toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
  });

  it('refuses a malformed trusted-proxy hop count', async () => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', 'two');
    await expect(boot()).rejects.toThrow(/TRUSTED_PROXY_HOPS/);
  });

  it('refuses an external database host reached without verifying TLS', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://app:pw@db.example.com:5432/liedmotif');
    await expect(boot()).rejects.toThrow(/sslmode/);
  });

  it('refuses a malformed pool size', async () => {
    vi.stubEnv('WEB_DB_POOL_MAX', '-4');
    await expect(boot()).rejects.toThrow(/WEB_DB_POOL_MAX/);
  });
});
