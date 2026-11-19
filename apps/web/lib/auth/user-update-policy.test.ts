import { describe, expect, it } from 'vitest';
import { MAX_USER_NAME_LENGTH } from '@liedmotif/shared';
import { refuseUserUpdate } from './user-update-policy';

// What `POST /api/auth/update-user` may write. Better Auth ships that endpoint
// to every signed-in user and writes `name`/`image` verbatim, so this rule is
// the only thing standing between a hand-rolled request and the app's own
// validation pipeline.

describe('refuseUserUpdate', () => {
  it('allows the writes the app itself makes', () => {
    expect(refuseUserUpdate({ name: 'John' })).toBeNull();
    // The avatar route's two writes: a fresh upload, and removal.
    expect(
      refuseUserUpdate({ image: '/api/avatar/1f6e9a3c-2f47-4c31-9a1e-6bb0d0a3f5f1' }),
    ).toBeNull();
    expect(refuseUserUpdate({ image: null })).toBeNull();
    // Untouched fields are not this rule's business.
    expect(refuseUserUpdate({})).toBeNull();
  });

  it('refuses a name past the user name cap', () => {
    expect(refuseUserUpdate({ name: 'x'.repeat(MAX_USER_NAME_LENGTH + 1) })).toMatch(/name/i);
  });

  it('refuses any image that is not an app avatar URL', () => {
    for (const image of [
      'https://evil.example/tracker.gif',
      '/api/avatar/not-a-uuid',
      '/api/avatar/1f6e9a3c-2f47-4c31-9a1e-6bb0d0a3f5f1/../../etc/passwd',
      '',
      42,
    ]) {
      expect(refuseUserUpdate({ image })).toMatch(/image/i);
    }
  });
});
