import { describe, expect, it, vi } from 'vitest';

// App-level rate limiting on the credential-verifying auth endpoints. The Better
// Auth handler itself is stubbed — these tests exercise
// OUR wrapper: failures consume per-IP budget, successes never do, and an
// exhausted IP gets a 429 WITHOUT reaching the handler. Distinct fake IPs
// isolate the cases (the limiter is a module singleton, keyed on the rightmost
// x-forwarded-for hop).

const authPost = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/auth', () => ({
  authRouteHandlers: () => ({ GET: vi.fn(), POST: authPost }),
}));

const { POST } = await import('@/app/api/auth/[...all]/route');

const FAILURE_LIMIT = 10; // mirrors `loginFailureLimiter` in lib/http/request-limits.ts

function signInRequest(ip: string) {
  return new Request('http://localhost/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email: 'admin@example.com', password: 'guess' }),
  });
}

describe('POST /api/auth/sign-in/email — login rate limiting', () => {
  it('blocks an IP after repeated failures, without calling the auth handler again', async () => {
    authPost.mockImplementation(async () => new Response(null, { status: 401 }));

    for (let i = 0; i < FAILURE_LIMIT; i += 1) {
      const res = await POST(signInRequest('203.0.113.1'));
      expect(res.status).toBe(401);
    }
    expect(authPost).toHaveBeenCalledTimes(FAILURE_LIMIT);

    const blocked = await POST(signInRequest('203.0.113.1'));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    // The credential check never ran for the blocked attempt.
    expect(authPost).toHaveBeenCalledTimes(FAILURE_LIMIT);
  });

  it('never throttles successful sign-ins (failures only consume budget)', async () => {
    authPost.mockImplementation(async () => new Response(null, { status: 200 }));

    for (let i = 0; i < FAILURE_LIMIT * 3; i += 1) {
      const res = await POST(signInRequest('203.0.113.2'));
      expect(res.status).toBe(200);
    }
  });

  it('keys on the client IP — another IP keeps its own budget', async () => {
    authPost.mockImplementation(async () => new Response(null, { status: 401 }));

    for (let i = 0; i < FAILURE_LIMIT + 1; i += 1) {
      await POST(signInRequest('203.0.113.3'));
    }
    expect((await POST(signInRequest('203.0.113.3'))).status).toBe(429);
    expect((await POST(signInRequest('203.0.113.4'))).status).toBe(401);
  });

  it('leaves sign-up disabled and non-credential routes unlimited', async () => {
    authPost.mockImplementation(async () => new Response(null, { status: 200 }));

    const signUp = await POST(
      new Request('http://localhost/api/auth/sign-up/email', { method: 'POST' }),
    );
    expect(signUp.status).toBe(403);

    const other = await POST(new Request('http://localhost/api/auth/sign-out', { method: 'POST' }));
    expect(other.status).toBe(200);
  });

  // The budget is consumed before the credential check, not recorded after the
  // response: otherwise every request in a parallel burst clears the gate before
  // the first failure lands, and one burst buys unlimited scrypt verifications.
  it('bounds a parallel burst of failures to the window budget', async () => {
    authPost.mockClear();
    authPost.mockImplementation(async () => new Response(null, { status: 401 }));

    const burst = await Promise.all(
      Array.from({ length: FAILURE_LIMIT * 2 }, () => POST(signInRequest('203.0.113.6'))),
    );

    expect(authPost).toHaveBeenCalledTimes(FAILURE_LIMIT);
    expect(burst.filter((res) => res.status === 429)).toHaveLength(FAILURE_LIMIT);
  });
});
