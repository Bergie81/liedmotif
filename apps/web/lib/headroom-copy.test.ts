import { describe, expect, it } from 'vitest';
import { HEADROOM_BLOCKED_MESSAGE, headroomBlockedMessage } from './headroom-copy';

// The refusal names which bound binds and, for a One-time Member
// budget, the one person who can raise it — never a rollover that will not come.
describe('headroomBlockedMessage', () => {
  it('keeps the instance copy for the Admin', () => {
    expect(headroomBlockedMessage({ scope: 'instance', window: 'day' }, null)).toBe(
      HEADROOM_BLOCKED_MESSAGE,
    );
  });

  it('promises a reset when a rolling Member budget binds', () => {
    expect(headroomBlockedMessage({ scope: 'member', window: 'day' }, 'John')).toBe(
      'You have used your tracks for now — new tracks when your budget resets. Resume one of your sessions from Sessions or play your Library instead.',
    );
  });

  it('says ask the Admin, by name, when a One-time Member budget binds', () => {
    expect(headroomBlockedMessage({ scope: 'member', window: 'total' }, 'John')).toBe(
      'Your budget is used up. Ask John for more. Resume one of your sessions from Sessions or play your Library instead.',
    );
    expect(headroomBlockedMessage({ scope: 'member', window: 'total' }, null)).toBe(
      'Your budget is used up. Ask the Admin for more. Resume one of your sessions from Sessions or play your Library instead.',
    );
  });

  it('keeps the shared-budget rollover copy when the Pool binds, whatever the Member kind', () => {
    const pool =
      'The shared budget is used up right now — new tracks resume when it resets. Resume one of your sessions from Sessions or play your Library instead.';
    expect(headroomBlockedMessage({ scope: 'pool', window: 'day' }, 'John')).toBe(pool);
    expect(headroomBlockedMessage({ scope: 'pool', window: 'month' }, null)).toBe(pool);
  });
});
