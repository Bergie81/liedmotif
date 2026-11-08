// The tri-state own-voice offer: a viewer who can never hold the capability
// gets `hidden` — resolved WITHOUT touching the database, pinned here with a
// Database whose every access throws. The Admin's not-yet states collapse to
// `setup` exactly as the create screens render them today. With the instance
// flag OWN_VOICE_ENABLED off, the feature is hidden for everyone.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@liedmotif/db';

const music = vi.hoisted(() => ({ customVoiceSupported: true }));
vi.mock('@/lib/providers', () => ({
  getMusicProvider: () => ({
    getCapabilities: () => ({ customVoice: { supported: music.customVoiceSupported } }),
  }),
}));

const { OWN_VOICE_NOT_OFFERED_MESSAGE, ownVoiceBlockedMessage, resolveOwnVoiceOffer } =
  await import('@/lib/voice');

/** Any read proves a broken short-circuit, so every access throws. */
const untouchableDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`resolveOwnVoiceOffer touched the database (read ${String(property)})`);
    },
  },
) as Database;

describe('resolveOwnVoiceOffer', () => {
  beforeEach(() => vi.stubEnv('OWN_VOICE_ENABLED', 'true'));
  afterEach(() => vi.unstubAllEnvs());

  it('resolves hidden for a member before any database read', async () => {
    music.customVoiceSupported = true;
    await expect(
      resolveOwnVoiceOffer(untouchableDb, { userId: 'member-1', role: 'member' }),
    ).resolves.toBe('hidden');
  });

  it('resolves setup for an admin when the music provider cannot sing with a custom voice', async () => {
    music.customVoiceSupported = false;
    await expect(
      resolveOwnVoiceOffer(untouchableDb, { userId: 'admin-1', role: 'admin' }),
    ).resolves.toBe('setup');
  });
});

describe('with OWN_VOICE_ENABLED off', () => {
  beforeEach(() => {
    music.customVoiceSupported = true;
    vi.stubEnv('OWN_VOICE_ENABLED', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('hides the offer from an admin before any database read', async () => {
    await expect(
      resolveOwnVoiceOffer(untouchableDb, { userId: 'admin-1', role: 'admin' }),
    ).resolves.toBe('hidden');
  });

  it('refuses an own-voice request before any database read', async () => {
    await expect(ownVoiceBlockedMessage(untouchableDb, 'admin-1')).resolves.toBe(
      OWN_VOICE_NOT_OFFERED_MESSAGE,
    );
  });
});
