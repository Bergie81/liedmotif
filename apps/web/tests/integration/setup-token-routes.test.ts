import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The two pre-auth gates on `/api/setup`, the one route that answers before an
// administrator exists. The bug both cover is instance takeover: on an exposed
// instance whoever POSTs /api/setup first becomes the sole administrator.
// `SETUP_TOKEN` decides *who may ask* — a token-less (or wrong-token) request
// must never reach account creation, and an instance with no token configured
// must leave the route open. The Origin check decides *which page may ask on a
// browser's behalf*, and it compares against the host the request was addressed
// to, because first-run `APP_PUBLIC_URL` is still whatever the image shipped.
//
// `/api/setup/validate` sits alongside it for the door the token does NOT open:
// the credential probe is admin-only whatever the setup state, so neither a
// correct token nor an instance nobody has claimed yet gets an answer out of it.
//
// The variable is stubbed rather than assigned: Vitest loads `.env`, so a
// developer whose own instance is token-gated would otherwise fail the
// unconfigured cases locally and pass them in CI.

const holder = vi.hoisted(() => ({
  adminExists: false,
  signUps: [] as string[],
  adminSessionUserId: 'admin-1' as string | null,
  seededSettings: 0,
}));

vi.mock('@/lib/db', () => ({ getDb: () => ({}), getPool: () => ({}) }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () =>
    holder.adminSessionUserId ? { user: { id: holder.adminSessionUserId } } : null,
  getAppSession: async () =>
    holder.adminSessionUserId ? { user: { id: holder.adminSessionUserId } } : null,
}));
vi.mock('@/lib/request-limits', () => ({
  submitLimiter: { check: () => ({ allowed: true, retryAfterMs: 0 }) },
  validateLimiter: { check: () => ({ allowed: true, retryAfterMs: 0 }) },
}));
vi.mock('@/lib/auth', () => ({
  getAuth: () => ({
    api: {
      signUpEmail: async ({ body }: { body: { email: string } }) => {
        holder.signUps.push(body.email);
        holder.adminExists = true;
        return { user: { id: 'admin-1' } };
      },
    },
  }),
}));
vi.mock('@/lib/providers', () => ({
  getStorageProvider: () => ({}),
}));
vi.mock('@liedmotif/db', async (importActual) => {
  const actual = await importActual<typeof import('@liedmotif/db')>();
  return {
    ...actual,
    adminExists: async () => holder.adminExists,
    assertCanCreateAdmin: async () => {},
    markSetupComplete: async () => {},
    upsertInstanceSettings: async () => {},
    withSetupAdvisoryLock: async <T>(_pool: unknown, run: () => Promise<T>) => run(),
    resolveProviderCredential: async () => ({
      providerKey: 'suno',
      config: null,
      readApiKey: () => 'secret-value',
    }),
  };
});
vi.mock('@liedmotif/db/seed', () => ({
  seedAppSettings: async () => {
    holder.seededSettings += 1;
  },
  ensurePlaceholderCover: async () => 'present',
}));
// The validate route's outbound step, stubbed so that a regression in its guard
// fails on the status assertion below instead of firing a real provider probe
// out of the test process.
vi.mock('@liedmotif/providers', async (importActual) => {
  const actual = await importActual<typeof import('@liedmotif/providers')>();
  return {
    ...actual,
    isBlockedValidationTargetResolved: async () => false,
    validateCredential: async () => ({ ok: true, reason: 'ok', message: 'fine' }),
  };
});

const { POST: setupPost } = await import('@/app/api/setup/route');
const { POST: validatePost } = await import('@/app/api/setup/validate/route');

const TOKEN = 'f7c1d3b9a25e4f6180c2d4e6f8a0b2c4';

// The header name is spelled out rather than imported, so renaming the constant
// cannot silently move the wire contract the setup screens depend on.
function tokenRequest(url: string, body: unknown, token?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers['x-setup-token'] = token;
  return new Request(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

const ADMIN_BODY = { admin: { email: 'owner@example.test', password: 'Long-enough-1!' } };
const VALIDATE_BODY = { providerType: 'music', providerKey: 'suno', secret: 'k' };

const postSetup = (token?: string) =>
  setupPost(tokenRequest('http://localhost/api/setup', ADMIN_BODY, token));
const postValidate = (token?: string) =>
  validatePost(tokenRequest('http://localhost/api/setup/validate', VALIDATE_BODY, token));

beforeEach(() => {
  holder.adminExists = false;
  holder.signUps = [];
  holder.adminSessionUserId = 'admin-1';
  holder.seededSettings = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('with SETUP_TOKEN configured', () => {
  beforeEach(() => {
    vi.stubEnv('SETUP_TOKEN', TOKEN);
  });

  it('refuses /api/setup without a token, creating no administrator', async () => {
    const response = await postSetup();
    expect(response.status).toBe(403);
    expect(holder.signUps).toEqual([]);
  });

  it('creates the administrator with the correct token', async () => {
    const response = await postSetup(TOKEN);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(holder.signUps).toEqual(['owner@example.test']);
  });

  // The Docker stack never runs `db:seed`, so setup is where a new install's
  // limits row — with the Admin's own ceilings off — gets written.
  it("seeds the new install's settings while creating the administrator", async () => {
    await postSetup(TOKEN);
    expect(holder.seededSettings).toBe(1);
  });

  // The token buys the administrator account, never the credential probe: it is
  // an oracle for which providers are configured and — through the SSRF guard's
  // Ollama loopback exemption — a localhost port scanner.
  it('refuses the credential probe to a token-bearing caller who is not signed in', async () => {
    holder.adminSessionUserId = null;
    expect((await postValidate(TOKEN)).status).toBe(401);
  });
});

describe('with SETUP_TOKEN unset', () => {
  beforeEach(() => {
    vi.stubEnv('SETUP_TOKEN', '');
  });

  it('leaves /api/setup open', async () => {
    const response = await postSetup();
    expect(response.status).toBe(200);
    expect(holder.signUps).toEqual(['owner@example.test']);
  });

  // The shipped default: no token, no administrator yet. The wizard never calls
  // the probe, so nothing legitimate loses an answer by refusing here.
  it('still refuses the credential probe on an unclaimed instance', async () => {
    holder.adminSessionUserId = null;
    expect((await postValidate()).status).toBe(401);
  });
});

describe('cross-origin posts', () => {
  /** The LAN address the operator browses, which `APP_PUBLIC_URL` does not name. */
  const SELF = 'http://192.168.1.10';

  function originRequest(path: string, body: unknown, origin: string): Request {
    return new Request(`${SELF}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    vi.stubEnv('SETUP_TOKEN', '');
    vi.stubEnv('APP_PUBLIC_URL', 'http://localhost:2206');
  });

  it('refuses a forged post, creating no administrator', async () => {
    const response = await setupPost(
      originRequest('/api/setup', ADMIN_BODY, 'https://evil.example'),
    );
    expect(response.status).toBe(403);
    expect(holder.signUps).toEqual([]);
  });

  it('refuses a forged credential probe', async () => {
    const response = await validatePost(
      originRequest('/api/setup/validate', VALIDATE_BODY, 'https://evil.example'),
    );
    expect(response.status).toBe(403);
  });

  it('accepts the wizard on an address APP_PUBLIC_URL does not name', async () => {
    const response = await setupPost(originRequest('/api/setup', ADMIN_BODY, SELF));
    expect(response.status).toBe(200);
    expect(holder.signUps).toEqual(['owner@example.test']);
  });
});
