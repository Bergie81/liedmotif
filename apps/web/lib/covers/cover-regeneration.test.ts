// A listener whose Cover regeneration failed because the image provider's
// account is not set up for images must learn that retrying will not help,
// while any other provider refusal keeps the generic wording.

import type { SessionCoverGenerationRow } from '@liedmotif/db';
import { describe, expect, it } from 'vitest';
import { toSessionCoverAttempt } from './cover-regeneration';

function settled(failureCategory: string): SessionCoverGenerationRow {
  return {
    id: 'cover-generation-1',
    coverImageId: 'cover-1',
    state: 'provider_rejected',
    failureCategory,
  } as SessionCoverGenerationRow;
}

describe('a failed Cover regeneration', () => {
  it.each([
    [
      'admin',
      "Your image provider's account isn't ready for images. Check Settings › AI Providers.",
    ],
    [
      'member',
      "The image provider's account on this server isn't ready for images. Ask the admin to check it.",
    ],
  ] as const)('tells the %s the image account is not ready and who can fix it', (role, message) => {
    expect(toSessionCoverAttempt(settled('account_not_ready'), role)).toEqual({
      coverGenerationId: 'cover-generation-1',
      coverImageId: 'cover-1',
      status: 'failed',
      failureMessageSafe: message,
    });
  });

  it('keeps the plain rejection wording for any other provider refusal', () => {
    expect(toSessionCoverAttempt(settled('provider_rejected'), 'admin').failureMessageSafe).toBe(
      'The image provider rejected this cover request.',
    );
  });
});
