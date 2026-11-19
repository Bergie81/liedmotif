import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_PROFILE_DESCRIPTION_LENGTH, MAX_USER_NAME_LENGTH } from '@liedmotif/shared';

// Profile route: artistName/description trim/round-trip, cover-reference frequency
// validation, and the artist-change → MP3 retag fan-out (best-effort enqueue).

const holder = vi.hoisted(() => ({
  authed: true,
  currentProfile: {
    name: 'John',
    email: 'admin@example.test',
    city: '',
    country: '',
    artistName: '',
    description: '',
  },
  updates: [] as unknown[],
  retagged: [] as string[][],
  sessionReads: [] as { disableCookieCache: boolean; hadHeaders: boolean }[],
  sessionReadShouldFail: false,
  correctPassword: 'Correct-Horse-42',
  verifiedPasswords: [] as string[],
  loginToken: 'this-browser' as string | null,
  revokedExcept: [] as (string | undefined)[],
  saveResult: { ok: true } as { ok: true } | { ok: false; reason: string },
  mailed: [] as string[],
}));

vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
type GetSessionInput = { headers: Headers; query?: { disableCookieCache?: boolean } };
// getAuth is replaced at its module boundary so the REAL
// `refreshSessionCookieCache` runs: the save must force a database-backed
// getSession (disableCookieCache) — that read is what re-signs the cookie cache
// with the just-written name/email. The refresh swallows failures, so a missing
// header is recorded rather than thrown; a throw here would pass silently.
vi.mock('@/lib/auth/auth', () => ({
  getAuth: () => ({
    api: {
      getSession: async ({ headers, query }: GetSessionInput) => {
        holder.sessionReads.push({
          disableCookieCache: query?.disableCookieCache === true,
          hadHeaders: headers instanceof Headers,
        });
        if (holder.sessionReadShouldFail) throw new Error('session read failed');
        return null;
      },
    },
  }),
}));
vi.mock('@/lib/auth/session', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/session')>();
  return {
    ...actual,
    getAdminSession: async () => (holder.authed ? { user: { id: 'owner-1' } } : null),
    getAppSession: async () => (holder.authed ? { user: { id: 'owner-1' } } : null),
    currentLoginToken: async () => holder.loginToken,
  };
});
vi.mock('@/lib/auth/account-mail', () => ({
  mailConfirmLink: async () => {
    holder.mailed.push('confirm-link');
    return true;
  },
  mailEmailChangedNotice: async () => {
    holder.mailed.push('email-changed-notice');
  },
}));
vi.mock('@/lib/worker-jobs', () => ({
  enqueueEmbedTrackMetadataBatch: async (_db: unknown, trackIds: string[]) => {
    holder.retagged.push(trackIds);
  },
}));
vi.mock('@liedmotif/db', async (importActual) => {
  const actual = await importActual<typeof import('@liedmotif/db')>();
  return {
    ...actual,
    getListenerProfile: async () => holder.currentProfile,
    // The Admin's own email change; the Member lock is covered elsewhere with a
    // real database.
    resolveUserProfile: async () => ({ role: 'admin', disabledAt: null }),
    updateListenerProfile: async (
      _db: unknown,
      _userId: string,
      profile: unknown,
      options?: { revokeOtherLoginsExcept?: string },
    ) => {
      if (!holder.saveResult.ok) return holder.saveResult;
      holder.updates.push(profile);
      holder.revokedExcept.push(options?.revokeOtherLoginsExcept);
      return holder.saveResult;
    },
    getConfirmedEmail: async () => holder.currentProfile.email,
    listFinalMp3TrackIdsForOwner: async () => ['track-1', 'track-2'],
    verifyCredentialPassword: async (_db: unknown, _userId: string, password: string) => {
      holder.verifiedPasswords.push(password);
      return password === holder.correctPassword;
    },
  };
});

const { POST } = await import('@/app/api/settings/profile/route');

function post(body: Record<string, unknown>, ip = '203.0.113.1'): Promise<Response> {
  return POST(
    new Request('http://localhost/api/settings/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    }),
  );
}

const BASE = {
  name: 'John',
  email: 'admin@example.test',
  city: '',
  country: '',
};

beforeEach(() => {
  // Account email off: the confirm mail an email change sends is covered
  // elsewhere with a real database.
  vi.stubEnv('SMTP_URL', '');
  vi.stubEnv('MAIL_FROM', '');
  holder.authed = true;
  holder.updates = [];
  holder.retagged = [];
  holder.sessionReads = [];
  holder.sessionReadShouldFail = false;
  holder.verifiedPasswords = [];
  holder.loginToken = 'this-browser';
  holder.revokedExcept = [];
  holder.saveResult = { ok: true };
  holder.mailed = [];
  holder.currentProfile = {
    name: 'John',
    email: 'admin@example.test',
    city: '',
    country: '',
    artistName: '',
    description: '',
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/settings/profile', () => {
  it('names the length limit for an over-long name and writes nothing', async () => {
    const res = await post({ ...BASE, name: 'x'.repeat(MAX_USER_NAME_LENGTH + 1) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      `Name must be at most ${MAX_USER_NAME_LENGTH} characters.`,
    );
    expect(holder.updates).toEqual([]);
  });

  it('trims and round-trips the optional artistName', async () => {
    const res = await post({ ...BASE, artistName: '  DJ John  ' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; profile: { artistName: string } };
    expect(body.profile.artistName).toBe('DJ John');
    expect((holder.updates[0] as { artistName: string }).artistName).toBe('DJ John');
  });

  it('does not accept legacy About or cover-frequency fields into the Profile contract', async () => {
    expect(
      (await post({ ...BASE, about: 'private context', coverReferenceFrequency: 'never' })).status,
    ).toBe(200);
    expect(holder.updates[0]).toEqual({ ...BASE, artistName: '', description: '' });
  });

  it('rejects an over-long artistName', async () => {
    expect((await post({ ...BASE, artistName: 'x'.repeat(81) })).status).toBe(400);
  });

  it('trims, collapses inner whitespace, and round-trips the optional description', async () => {
    const res = await post({ ...BASE, description: '  Night owl,\n\n  synth collector.  ' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profile: { description: string } };
    expect(body.profile.description).toBe('Night owl, synth collector.');
    expect((holder.updates[0] as { description: string }).description).toBe(
      'Night owl, synth collector.',
    );
  });

  it('refuses an over-long description and writes nothing', async () => {
    const res = await post({
      ...BASE,
      description: 'x'.repeat(MAX_PROFILE_DESCRIPTION_LENGTH + 1),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/description/i);
    expect(holder.updates).toEqual([]);
  });

  it('enqueues MP3 retags when the effective artist changes (set AND clear)', async () => {
    // '' -> 'DJ John' (set): effective artist changes from the User name.
    await post({ ...BASE, artistName: 'DJ John' });
    expect(holder.retagged).toEqual([['track-1', 'track-2']]);

    // Clearing it falls back to the User name → changes again.
    holder.currentProfile = { ...holder.currentProfile, artistName: 'DJ John' };
    holder.retagged = [];
    await post({ ...BASE, artistName: '' });
    expect(holder.retagged).toEqual([['track-1', 'track-2']]);
  });

  it('does not enqueue retags when the effective artist is unchanged', async () => {
    await post(BASE); // '' -> '' (still the User name)
    expect(holder.retagged).toEqual([]);
  });

  it('re-signs the session cookie cache after saving name/email', async () => {
    expect((await post({ ...BASE, name: 'Tom' })).status).toBe(200);
    expect(holder.sessionReads).toEqual([{ disableCookieCache: true, hadHeaders: true }]);
  });

  it('leaves the cookie cache alone when the save is refused', async () => {
    expect((await post({ ...BASE, name: '' })).status).toBe(400);
    expect(holder.sessionReads).toEqual([]);
  });

  // The login email is the account identifier: a hijacked session that can move
  // it, then set a password from a reset link, owns the account outright.
  // Owner auth alone is not enough to write it.
  it('refuses an email change without the current password, and writes nothing', async () => {
    const res = await post({ ...BASE, email: 'attacker@example.test' });
    expect(res.status).toBe(400);
    expect(holder.updates).toEqual([]);
    expect(holder.verifiedPasswords).toEqual([]);
  });

  it('refuses an email change on a wrong current password, and writes nothing', async () => {
    const res = await post({
      ...BASE,
      email: 'attacker@example.test',
      currentPassword: 'not-the-password',
    });
    expect(res.status).toBe(400);
    expect(holder.updates).toEqual([]);
    expect(holder.verifiedPasswords).toEqual(['not-the-password']);
  });

  // The current password is all that stands between a stolen cookie and the
  // sign-in address, so guessing it spends the sign-in failure budget of the
  // caller's IP.
  it('counts wrong current passwords against the sign-in budget', async () => {
    const change = (currentPassword: string) =>
      post({ ...BASE, email: 'attacker@example.test', currentPassword }, '203.0.113.30');

    for (let i = 0; i < 10; i += 1) {
      expect((await change('not-the-password')).status).toBe(400);
    }
    const right = await change('Correct-Horse-42');

    expect(right.status).toBe(429);
    expect(holder.updates).toEqual([]);
  });

  it('saves an email change on the correct password and revokes the other Logins', async () => {
    const res = await post({
      ...BASE,
      email: 'new@example.test',
      currentPassword: 'Correct-Horse-42',
    });
    expect(res.status).toBe(200);
    expect((holder.updates[0] as { email: string }).email).toBe('new@example.test');
    // Revoked in the SAME write, so a rejected address can never leave the user
    // signed out of devices the change never reached.
    expect(holder.revokedExcept).toEqual(['this-browser']);

    // A save that does NOT move the email must not sign the user's other
    // devices out, nor ask them for a password.
    holder.currentProfile = { ...holder.currentProfile, email: 'new@example.test' };
    expect((await post({ ...BASE, email: 'new@example.test', name: 'Tom' })).status).toBe(200);
    expect(holder.revokedExcept).toEqual(['this-browser', undefined]);
    expect(holder.verifiedPasswords).toEqual(['Correct-Horse-42']);
  });

  // The repo refuses the address while an open Invite carries it; the route
  // must say how to clear the way, not send the Admin hunting for another one.
  it('refuses an email change onto an address an open Invite carries, mailing nothing', async () => {
    vi.stubEnv('SMTP_URL', 'smtp://mail.example.test:1025');
    vi.stubEnv('MAIL_FROM', 'Liedmotif <liedmotif@example.test>');
    holder.saveResult = { ok: false, reason: 'email_has_open_invite' };

    const res = await post({
      ...BASE,
      email: 'Anna@Example.com',
      currentPassword: 'Correct-Horse-42',
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'That address has an open invite. Revoke the invite first.',
    );
    expect(holder.updates).toEqual([]);
    expect(holder.mailed).toEqual([]);
    expect(holder.sessionReads).toEqual([]);
  });

  it('still succeeds and retags when the cookie refresh fails', async () => {
    // A failed refresh only means the cache stays stale until its maxAge —
    // never worth failing a save whose write already committed.
    holder.sessionReadShouldFail = true;
    expect((await post({ ...BASE, artistName: 'DJ John' })).status).toBe(200);
    expect(holder.updates).toHaveLength(1);
    expect(holder.retagged).toEqual([['track-1', 'track-2']]);
  });
});
