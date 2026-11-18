import type { CreationHeadroomDecision } from '@liedmotif/shared';
import { describe, expect, it } from 'vitest';
import {
  creationHeadroomMessage,
  HEADROOM_BLOCKED_MESSAGE,
  headroomBlockedMessage,
} from './headroom-copy';

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

// A creation refusal says the numbers: what a new Session needs, what is left,
// and when more comes back — or that waiting cannot help. "Used up" only when
// nothing is left.
describe('creationHeadroomMessage', () => {
  const WAY_OUT = 'Resume one of your sessions from Sessions or play your Library instead.';
  const context = { adminName: 'John', resetTimezone: 'Europe/Berlin' };
  const refused = (
    decision: Partial<CreationHeadroomDecision> &
      Pick<CreationHeadroomDecision, 'scope' | 'window'>,
  ): CreationHeadroomDecision => ({
    allowed: false,
    remainingTracks: 4,
    minHeadroomTracks: 5,
    windowCapTracks: 80,
    ...decision,
  });

  it('names what a Session needs and what is left, never "used", when Tracks are left', () => {
    const message = creationHeadroomMessage(refused({ scope: 'member', window: 'day' }), context);
    expect(message).toBe(
      `A new Session needs 5 Tracks; you have 4 left today. More Tracks at midnight (Europe/Berlin). ${WAY_OUT}`,
    );
    expect(message).not.toMatch(/used/);
  });

  it('gives the Admin the numbers and the reset, a month window on the 1st', () => {
    expect(creationHeadroomMessage(refused({ scope: 'instance', window: 'month' }), context)).toBe(
      `A new Session needs 5 Tracks; you have 4 left this month. More Tracks on the 1st (Europe/Berlin). ${WAY_OUT}`,
    );
    expect(
      creationHeadroomMessage(
        refused({ scope: 'instance', window: 'day', remainingTracks: 0 }),
        context,
      ),
    ).toBe(
      `A new Session needs 5 Tracks; you have none left today. More Tracks at midnight (Europe/Berlin). ${WAY_OUT}`,
    );
  });

  it('calls the Pool the shared budget, and never hints the Member could change it', () => {
    expect(creationHeadroomMessage(refused({ scope: 'pool', window: 'day' }), context)).toBe(
      `A new Session needs 5 Tracks; the shared budget has 4 left today. More Tracks at midnight (Europe/Berlin). ${WAY_OUT}`,
    );
  });

  it('keeps the used-up texts when nothing is left of a Member or Pool budget', () => {
    expect(
      creationHeadroomMessage(
        refused({ scope: 'member', window: 'day', remainingTracks: 0 }),
        context,
      ),
    ).toBe(headroomBlockedMessage({ scope: 'member', window: 'day' }, 'John'));
    expect(
      creationHeadroomMessage(
        refused({ scope: 'pool', window: 'month', remainingTracks: 0 }),
        context,
      ),
    ).toBe(headroomBlockedMessage({ scope: 'pool', window: 'month' }, 'John'));
    expect(
      creationHeadroomMessage(
        refused({ scope: 'member', window: 'total', remainingTracks: 0, windowCapTracks: 20 }),
        context,
      ),
    ).toBe(headroomBlockedMessage({ scope: 'member', window: 'total' }, 'John'));
  });

  it('promises no reset for a One-time budget with Tracks left: it says ask the Admin, by name', () => {
    const oneTime = refused({ scope: 'member', window: 'total', windowCapTracks: 20 });
    expect(creationHeadroomMessage(oneTime, context)).toBe(
      `A new Session needs 5 Tracks; you have 4 left. Your budget doesn’t reset — ask John for more. ${WAY_OUT}`,
    );
    expect(creationHeadroomMessage(oneTime, { ...context, adminName: null })).toBe(
      `A new Session needs 5 Tracks; you have 4 left. Your budget doesn’t reset — ask the Admin for more. ${WAY_OUT}`,
    );
  });

  it('says waiting cannot help when the window’s own cap is below what a Session needs', () => {
    const below = { remainingTracks: 4, windowCapTracks: 4 };
    expect(
      creationHeadroomMessage(refused({ scope: 'instance', window: 'day', ...below }), context),
    ).toBe(
      `A new Session needs 5 Tracks, but your daily limit is only 4, so waiting won’t help. Adjust your cost limits to start one. ${WAY_OUT}`,
    );
    expect(
      creationHeadroomMessage(refused({ scope: 'member', window: 'month', ...below }), context),
    ).toBe(
      `A new Session needs 5 Tracks, but your monthly budget is only 4, so waiting won’t help. Ask John for more. ${WAY_OUT}`,
    );
    expect(
      creationHeadroomMessage(refused({ scope: 'pool', window: 'day', ...below }), {
        ...context,
        adminName: null,
      }),
    ).toBe(
      `A new Session needs 5 Tracks, but the shared daily budget is only 4, so waiting won’t help. Ask the Admin about it. ${WAY_OUT}`,
    );
  });

  it('counts one Track in the singular', () => {
    expect(
      creationHeadroomMessage(
        refused({ scope: 'instance', window: 'day', minHeadroomTracks: 1, remainingTracks: 0 }),
        context,
      ),
    ).toMatch(/^A new Session needs 1 Track; /);
  });
});
