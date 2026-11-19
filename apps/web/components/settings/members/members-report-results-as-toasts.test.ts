// @vitest-environment jsdom

// Settings → Members reports what a save, an invite, a reset or an account
// action did as a toast, so the cards stay put. What carries something to act
// on stays on the card: an Invite or reset link to copy and the line that
// explains it, and the shared budget's over-subscription warnings.

import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MEMBER_LIMITS,
  DEFAULT_MEMBERS_POOL,
  type PoolOverSubscription,
} from '@liedmotif/shared';
import type { MembersAdminMember } from '@/lib/members-admin-data';
import { shownToasts, toast } from '@/lib/toast';
import { InviteMembersSection } from './invite-members-section';
import { MemberCards } from './member-cards';
import { PoolPanel } from './pool-panel';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.unstubAllGlobals();
});

const UNIT_COSTS = { perTrackUsd: 0, perCoverUsd: 0 };
const UNUSED = { used: 0, limit: 10, remaining: 10 };
const FIGURES = { tracksDay: UNUSED, tracksMonth: UNUSED, coversDay: UNUSED, coversMonth: UNUSED };
const OVER: PoolOverSubscription = { field: 'dailyGenerationTasks', membersTotal: 30, poolCap: 25 };
const OVER_LINE =
  "Members' daily Track budgets add up to 60 Tracks; the shared pool allows 50. That is fine — the pool is first come, first served.";

/** Answers each request in turn with the next of `answers`. */
function stubAnswers(...answers: Array<{ status: number; body: unknown }>) {
  const queue = [...answers];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const answer = queue.shift() ?? { status: 500, body: {} };
      return Response.json(answer.body, { status: answer.status });
    }),
  );
}

const failure = (message: string) => ({ status: 400, body: { ok: false, error: { message } } });
const success = (data: unknown = {}) => ({ status: 200, body: { ok: true, data } });

function shown() {
  return shownToasts().map(({ tone, message }) => ({ tone, message }));
}

function renderPool(overSubscription: PoolOverSubscription[] = []) {
  render(
    h(PoolPanel, {
      pool: DEFAULT_MEMBERS_POOL,
      poolFigures: FIGURES,
      overSubscription,
      tracksPerCall: 2,
      minHeadroomTracks: 5,
      unitCosts: UNIT_COSTS,
    }),
  );
}

function renderInvites(inviteByEmail: boolean) {
  render(
    h(InviteMembersSection, {
      invites: [
        {
          id: 'invite-1',
          label: 'Mara',
          email: null,
          expiresAt: '2026-11-24T10:00:00.000Z',
        },
      ] as never,
      inviteByEmail,
      defaultBudget: DEFAULT_MEMBER_LIMITS,
      tracksPerCall: 2,
      minHeadroomTracks: 5,
      unitCosts: UNIT_COSTS,
    }),
  );
}

const MEMBER: MembersAdminMember = {
  userId: 'member-1',
  name: 'Lisa',
  joinedAt: '2026-09-01T10:00:00.000Z',
  lastActiveAt: null,
  disabled: false,
  trackCount: 0,
  storageBytes: 0,
  budget: DEFAULT_MEMBER_LIMITS,
  usage: { kind: 'rolling', figures: FIGURES },
  assistant: {},
};

function renderMember() {
  render(
    h(MemberCards, {
      members: [MEMBER],
      tracksPerCall: 2,
      minHeadroomTracks: 5,
      unitCosts: UNIT_COSTS,
      assistantDefault: null,
    }),
  );
}

const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

describe('shared budget — results as toasts', () => {
  it('reports a saved shared budget as a success toast', async () => {
    stubAnswers(success({ overSubscription: [] }));
    renderPool();

    click('Save shared budget');

    await waitFor(() =>
      expect(shown()).toEqual([{ tone: 'success', message: 'Shared budget saved.' }]),
    );
    expect(screen.queryByText('Shared budget saved.')).toBeNull();
  });

  it('reports a failed save as one error toast that a successful retry clears', async () => {
    stubAnswers(failure('Database offline.'), success({ overSubscription: [] }));
    renderPool();

    click('Save shared budget');
    await waitFor(() => expect(shown()).toEqual([{ tone: 'error', message: 'Database offline.' }]));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save shared budget' })));
    click('Save shared budget');

    await waitFor(() =>
      expect(shown()).toEqual([{ tone: 'success', message: 'Shared budget saved.' }]),
    );
  });

  it('keeps an over-subscription warning on the panel', async () => {
    stubAnswers(success({ overSubscription: [OVER] }));
    renderPool();

    click('Save shared budget');

    expect(await screen.findByText(OVER_LINE)).toBeTruthy();
  });
});

describe('invites — results as toasts', () => {
  it('reports a mailed invite as a success toast', async () => {
    stubAnswers(success({}));
    renderInvites(true);

    fireEvent.change(screen.getByPlaceholderText('Lisa'), { target: { value: 'Lisa' } });
    fireEvent.change(screen.getByPlaceholderText('lisa@example.com'), {
      target: { value: 'lisa@example.com' },
    });
    click('Send invite');

    await waitFor(() =>
      expect(shown()).toEqual([
        { tone: 'success', message: 'Invite sent to lisa@example.com. The link works for 7 days.' },
      ]),
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps a minted invite link on the card to copy', async () => {
    stubAnswers(success({ url: 'https://liedmotif.example/invite/abc' }));
    renderInvites(false);

    fireEvent.change(screen.getByPlaceholderText('Lisa'), { target: { value: 'Lisa' } });
    click('Create invite link');

    expect(
      ((await screen.findByRole('textbox', { name: 'Invite link' })) as HTMLInputElement).value,
    ).toBe('https://liedmotif.example/invite/abc');
    expect(shown()).toEqual([]);
  });

  it('reports an unnamed invite and a failed revoke as error toasts', async () => {
    stubAnswers(failure('Invite not found.'));
    renderInvites(false);

    click('Create invite link');
    await waitFor(() =>
      expect(shown()).toEqual([
        { tone: 'error', message: 'Give the invite a name — who is this for?' },
      ]),
    );
    click('Revoke');

    await waitFor(() =>
      expect(shown()).toContainEqual({ tone: 'error', message: 'Invite not found.' }),
    );
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('Member cards — results as toasts', () => {
  it('reports a saved budget as a success toast', async () => {
    stubAnswers(success({ overSubscription: [] }));
    renderMember();

    click('Edit budget');
    click('Save budget');

    await waitFor(() =>
      expect(shown()).toEqual([
        { tone: 'success', message: 'Budget saved — it applies at the next generation.' },
      ]),
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('reports a budget saved past the shared pool as a warning toast', async () => {
    stubAnswers(success({ overSubscription: [OVER] }));
    renderMember();

    click('Edit budget');
    click('Save budget');

    await waitFor(() =>
      expect(shown()).toEqual([{ tone: 'warning', message: `Saved. ${OVER_LINE}` }]),
    );
  });

  it('reports a mailed reset as a success toast', async () => {
    stubAnswers(success({ sent: true, to: 'lisa@example.com' }));
    renderMember();

    click('Reset password');

    await waitFor(() =>
      expect(shown()).toEqual([
        {
          tone: 'success',
          message: 'Reset mail sent to lisa@example.com. The link works for 1 hour.',
        },
      ]),
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps a reset link on the card to copy', async () => {
    stubAnswers(success({ url: 'https://liedmotif.example/reset/abc', reason: 'email_off' }));
    renderMember();

    click('Reset password');

    expect(
      ((await screen.findByRole('textbox', { name: 'Password reset link' })) as HTMLInputElement)
        .value,
    ).toBe('https://liedmotif.example/reset/abc');
    expect(shown()).toEqual([]);
  });

  it('reports a failed account action as an error toast', async () => {
    stubAnswers(failure('Member not found.'));
    renderMember();

    click('Disable account');

    await waitFor(() => expect(shown()).toEqual([{ tone: 'error', message: 'Member not found.' }]));
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('Member cards — delete confirmation', () => {
  // Liedmotif cannot reach into a device, so the confirmation must not read as
  // if deleting a Member removes their offline copies too.
  it('says the music a Member kept offline stays on their own devices', () => {
    renderMember();

    click('Delete');

    expect(
      screen.getByText(/Music they kept offline on their own devices stays there\./),
    ).toBeTruthy();
  });
});
