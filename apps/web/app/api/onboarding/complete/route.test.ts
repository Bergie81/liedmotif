import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  complete: vi.fn(async () => ({ completedAt: '2026-07-25T09:00:00.000Z' })),
  adminSession: vi.fn(),
}));

vi.mock('@liedmotif/db', () => ({ completeOnboarding: mocks.complete }));
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('@/lib/session', () => ({ getAppSession: mocks.adminSession }));

const { POST } = await import('./route');

/** A same-origin API call: the guards look only at the absent `Origin`. */
const apiRequest = () => new Request('http://localhost/api');

describe('onboarding completion', () => {
  beforeEach(() => {
    mocks.complete.mockClear();
    mocks.adminSession.mockResolvedValue({ user: { id: 'admin-1' } });
  });

  it('stamps completion for the signed-in owner and answers with the state', async () => {
    const response = await POST(apiRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: { completedAt: '2026-07-25T09:00:00.000Z' },
    });
    expect(mocks.complete).toHaveBeenCalledWith({}, 'admin-1');
  });

  it('refuses to onboard anyone who is not the signed-in admin', async () => {
    mocks.adminSession.mockResolvedValue(null);

    const response = await POST(apiRequest());

    expect(response.status).toBe(401);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
