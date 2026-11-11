import { describe, expect, it, vi } from 'vitest';

// Better Auth's own reset, verification, and password-setting endpoints:
// the `invites` table is the one link
// machinery and the app's own routes own the signed-in password change, so the
// library's parallel paths are refused at the catch-all before its handler runs —
// whatever the auth config later turns on. The handler is stubbed: this pins
// OUR wrapper, for both methods, since the library routes GET callbacks too.

const handlers = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('@/lib/auth', () => ({ authRouteHandlers: () => handlers }));

const { GET, POST } = await import('@/app/api/auth/[...all]/route');

const REFUSED_PATHS = [
  '/request-password-reset',
  '/forget-password',
  '/reset-password',
  '/reset-password/some-token?callbackURL=/',
  '/send-verification-email',
  '/verify-email?token=some-token',
  '/change-password',
  '/set-password',
  '/verify-password',
  '/update-user',
];

function authRequest(method: 'GET' | 'POST', path: string): Request {
  return new Request(`http://localhost/api/auth${path}`, {
    method,
    headers: { 'x-forwarded-for': '203.0.113.90' },
  });
}

describe('the auth catch-all refuses Better Auth’s reset, verification, and password-setting endpoints', () => {
  for (const path of REFUSED_PATHS) {
    it(`refuses GET and POST ${path}`, async () => {
      expect((await GET(authRequest('GET', path))).status).toBe(404);
      expect((await POST(authRequest('POST', path))).status).toBe(404);
      expect(handlers.GET).not.toHaveBeenCalled();
      expect(handlers.POST).not.toHaveBeenCalled();
    });
  }

  it('still hands every other endpoint to Better Auth', async () => {
    handlers.GET.mockResolvedValue(new Response(null, { status: 200 }));

    expect((await GET(authRequest('GET', '/get-session'))).status).toBe(200);
    expect(handlers.GET).toHaveBeenCalledTimes(1);
  });
});
