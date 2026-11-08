// Behavior contract for the server-side access guards: which requests pass, and
// where the rest are redirected. The underlying session/profile/onboarding reads
// are wrapped in React's per-request `cache`; that memoization only activates
// under the `react-server` condition, so these tests pin the guard behavior the
// wrapping must preserve rather than counting calls.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  resolveUserProfile: vi.fn(),
  getSetupState: vi.fn(),
  getOnboardingState: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/auth', () => ({
  getAuth: () => ({ api: { getSession: mocks.getSession } }),
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('@liedmotif/db', () => ({
  resolveUserProfile: mocks.resolveUserProfile,
  getSetupState: mocks.getSetupState,
  getOnboardingState: mocks.getOnboardingState,
}));

const {
  requireAppAccess,
  requireAdmin,
  requireOnboardingAccess,
  getAdminSession,
  getAppSession,
  resolveAccountState,
} = await import('@/lib/session');
const { resetOnboardingMemoForTests } = await import('./onboarding-memo');

const adminSession = { session: { id: 's1' }, user: { id: 'admin-1' } };
const memberSession = { session: { id: 's2' }, user: { id: 'member-1' } };

async function redirectTargetOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('REDIRECT:')) return message.slice('REDIRECT:'.length);
    throw error;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  // Completed onboarding is memoized process-wide; each case states its own.
  resetOnboardingMemoForTests();
  mocks.getSession.mockResolvedValue(adminSession);
  mocks.resolveUserProfile.mockResolvedValue({ role: 'admin', disabledAt: null });
  mocks.getSetupState.mockResolvedValue('login');
  mocks.getOnboardingState.mockResolvedValue({ completedAt: '2026-07-01T00:00:00.000Z' });
});

function signInAsMember(disabledAt: Date | null = null) {
  mocks.getSession.mockResolvedValue(memberSession);
  mocks.resolveUserProfile.mockResolvedValue({ role: 'member', disabledAt });
}

describe('requireAppAccess', () => {
  it('returns the session AND the resolved role for a signed-in, onboarded admin', async () => {
    await expect(requireAppAccess()).resolves.toEqual({ session: adminSession, role: 'admin' });
  });

  it('returns the session AND the resolved role for a signed-in, onboarded member', async () => {
    signInAsMember();
    await expect(requireAppAccess()).resolves.toEqual({ session: memberSession, role: 'member' });
  });

  it('sends a signed-out visitor to login once an admin exists', async () => {
    mocks.getSession.mockResolvedValue(null);
    expect(await redirectTargetOf(requireAppAccess)).toBe('/login');
  });

  it('sends a signed-out visitor to setup when no admin exists yet', async () => {
    mocks.getSession.mockResolvedValue(null);
    mocks.getSetupState.mockResolvedValue('setup');
    expect(await redirectTargetOf(requireAppAccess)).toBe('/setup');
  });

  it('treats a session without a profile row as not signed in', async () => {
    mocks.resolveUserProfile.mockResolvedValue(null);
    expect(await redirectTargetOf(requireAppAccess)).toBe('/login');
  });

  it('sends a disabled admin to the account-disabled page, not into a bounce loop', async () => {
    mocks.resolveUserProfile.mockResolvedValue({ role: 'admin', disabledAt: new Date() });
    expect(await redirectTargetOf(requireAppAccess)).toBe('/account-disabled');
  });

  it('sends a disabled member to the account-disabled page', async () => {
    signInAsMember(new Date());
    expect(await redirectTargetOf(requireAppAccess)).toBe('/account-disabled');
  });

  it('diverts an un-onboarded admin to /welcome', async () => {
    mocks.getOnboardingState.mockResolvedValue({ completedAt: null });
    expect(await redirectTargetOf(requireAppAccess)).toBe('/welcome');
  });

  it('diverts an un-onboarded member to /welcome', async () => {
    signInAsMember();
    mocks.getOnboardingState.mockResolvedValue({ completedAt: null });
    expect(await redirectTargetOf(requireAppAccess)).toBe('/welcome');
  });

  it('resolves role and disabled state per request from the profile, not the cookie', async () => {
    signInAsMember();
    await requireAppAccess();
    expect(mocks.resolveUserProfile).toHaveBeenCalledWith(expect.anything(), 'member-1');
  });
});

describe('requireAdmin', () => {
  it('returns the session for the admin', async () => {
    await expect(requireAdmin()).resolves.toBe(adminSession);
  });

  it('redirects a member to the app instead of rendering', async () => {
    signInAsMember();
    expect(await redirectTargetOf(requireAdmin)).toBe('/');
  });

  it('refuses a disabled admin', async () => {
    mocks.resolveUserProfile.mockResolvedValue({ role: 'admin', disabledAt: new Date() });
    expect(await redirectTargetOf(requireAdmin)).toBe('/account-disabled');
  });

  it('sends a signed-out visitor to login', async () => {
    mocks.getSession.mockResolvedValue(null);
    expect(await redirectTargetOf(requireAdmin)).toBe('/login');
  });
});

describe('requireOnboardingAccess', () => {
  it('lets an un-onboarded admin into the flow', async () => {
    mocks.getOnboardingState.mockResolvedValue({ completedAt: null });
    await expect(requireOnboardingAccess()).resolves.toEqual({
      session: adminSession,
      role: 'admin',
    });
  });

  it('lets an un-onboarded member into the flow', async () => {
    signInAsMember();
    mocks.getOnboardingState.mockResolvedValue({ completedAt: null });
    await expect(requireOnboardingAccess()).resolves.toEqual({
      session: memberSession,
      role: 'member',
    });
  });

  it('bounces an already-onboarded user to the app', async () => {
    expect(await redirectTargetOf(requireOnboardingAccess)).toBe('/');
  });
});

describe('getAppSession', () => {
  it('returns the session for admin and member alike', async () => {
    await expect(getAppSession()).resolves.toBe(adminSession);
    signInAsMember();
    await expect(getAppSession()).resolves.toBe(memberSession);
  });

  it('returns null for signed-out, profile-less, and disabled requests', async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(getAppSession()).resolves.toBeNull();

    mocks.getSession.mockResolvedValue(memberSession);
    mocks.resolveUserProfile.mockResolvedValue(null);
    await expect(getAppSession()).resolves.toBeNull();

    signInAsMember(new Date());
    await expect(getAppSession()).resolves.toBeNull();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe('getAdminSession', () => {
  it('returns the session only for the active admin', async () => {
    await expect(getAdminSession()).resolves.toBe(adminSession);
  });

  it('returns null for signed-out, member, and disabled-admin requests', async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(getAdminSession()).resolves.toBeNull();

    signInAsMember();
    await expect(getAdminSession()).resolves.toBeNull();

    mocks.getSession.mockResolvedValue(adminSession);
    mocks.resolveUserProfile.mockResolvedValue({ role: 'admin', disabledAt: new Date() });
    await expect(getAdminSession()).resolves.toBeNull();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe('resolveAccountState', () => {
  it('classifies the request for the account-disabled page', async () => {
    signInAsMember(new Date());
    await expect(resolveAccountState()).resolves.toEqual({ kind: 'disabled' });

    signInAsMember();
    await expect(resolveAccountState()).resolves.toEqual({ kind: 'active' });

    mocks.getSession.mockResolvedValue(null);
    await expect(resolveAccountState()).resolves.toEqual({ kind: 'none' });
  });
});
