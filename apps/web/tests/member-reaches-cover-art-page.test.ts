// Settings → Cover art holds each User's own preferences, so a signed-in Member
// opens the page through the real access guard, onto their own settings, rather
// than being redirected away by an Admin check.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCoverArtSettings: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/auth', () => ({
  getAuth: () => ({
    api: { getSession: async () => ({ session: { id: 's1' }, user: { id: 'member-1' } }) },
  }),
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('@/lib/providers', () => ({ getLlmProvider: async () => null }));
vi.mock('@liedmotif/db', () => ({
  resolveUserProfile: async () => ({ role: 'member', disabledAt: null }),
  getSetupState: async () => 'login',
  getOnboardingState: async () => ({ completedAt: '2026-07-01T00:00:00.000Z' }),
  getCoverArtSettings: mocks.getCoverArtSettings,
}));

const { default: CoverArtPage } = await import('@/app/(app)/settings/cover-art/page');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCoverArtSettings.mockResolvedValue({
    defaultStyle: 'poster_art',
    customStyleDefinition: '',
    useStandardCoverArt: false,
    promptEnhancementEnabled: true,
  });
});

describe('Settings → Cover art page access', () => {
  it('lets a Member open the page, on their own settings', async () => {
    await expect(CoverArtPage()).resolves.toBeTruthy();

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.getCoverArtSettings).toHaveBeenCalledWith(expect.anything(), 'member-1');
  });
});
