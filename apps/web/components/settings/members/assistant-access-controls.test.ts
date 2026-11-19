// @vitest-environment jsdom

// The Assistant controls on Settings → Members: the instance default, each
// Member's switch and daily allowance, and what the screen shows while no
// Text AI is connected.

import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_MEMBER_LIMITS, type MemberAssistantAccess } from '@liedmotif/shared';
import type { MembersAdminMember } from '@/lib/members-admin-data';
import { shownToasts, toast } from '@/lib/toast';
import { AssistantDefaultPanel } from './assistant-access-controls';
import { MemberCards } from './member-cards';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.unstubAllGlobals();
});

const INSTANCE_DEFAULT = { enabled: true, dailyMessages: 30 };
const UNIT_COSTS = { perTrackUsd: 0, perCoverUsd: 0 };
const UNUSED = { used: 0, limit: 10, remaining: 10 };

function member(assistant: MemberAssistantAccess): MembersAdminMember {
  return {
    userId: 'member-1',
    name: 'Lisa',
    joinedAt: '2026-09-01T10:00:00.000Z',
    lastActiveAt: null,
    disabled: false,
    trackCount: 0,
    storageBytes: 0,
    budget: DEFAULT_MEMBER_LIMITS,
    usage: {
      kind: 'rolling',
      figures: { tracksDay: UNUSED, tracksMonth: UNUSED, coversDay: UNUSED, coversMonth: UNUSED },
    },
    assistant,
  };
}

function memberCards(assistant: MemberAssistantAccess, assistantDefault = INSTANCE_DEFAULT) {
  return h(MemberCards, {
    members: [member(assistant)],
    tracksPerCall: 2,
    minHeadroomTracks: 5,
    unitCosts: UNIT_COSTS,
    assistantDefault,
    timezone: 'UTC',
  });
}

/** Answers every save with `access`, and records what was sent where. */
function stubSaves(access: object): Array<{ url: string; body: unknown }> {
  const sent: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return Response.json({ ok: true, data: { access } });
  });
  return sent;
}

function stubFailingSaves(message: string): void {
  vi.stubGlobal('fetch', async () =>
    Response.json({ ok: false, error: { message } }, { status: 500 }),
  );
}

const memberSwitch = () => screen.getByRole('switch', { name: 'Assistant for Lisa' });
const memberAllowance = () =>
  screen.getByRole('textbox', { name: 'Messages per day for Lisa' }) as HTMLInputElement;
/** The line under a control's label: where its value comes from, and the way back. */
const note = (control: HTMLElement) =>
  document.getElementById(control.getAttribute('aria-describedby') ?? '') as HTMLElement;

it('shows a hint instead of the default while no Text AI is connected', () => {
  render(h(AssistantDefaultPanel, { access: null }));

  expect(screen.getByText(/runs on your Text AI/)).toBeTruthy();
  expect(screen.queryByRole('switch')).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
});

it("leaves the Assistant controls off a Member's card while no Text AI is connected", () => {
  render(h(MemberCards, { ...memberCards({}).props, assistantDefault: null }));

  expect(screen.getByText('Lisa')).toBeTruthy();
  expect(screen.queryByRole('switch')).toBeNull();
  expect(screen.queryByText('Messages per day')).toBeNull();
});

it('saves a change to the default as soon as it is made', async () => {
  const sent = stubSaves({ enabled: false, dailyMessages: 30 });
  render(h(AssistantDefaultPanel, { access: INSTANCE_DEFAULT }));
  const toggle = screen.getByRole('switch', { name: 'Assistant for Members' });
  expect(toggle.getAttribute('aria-checked')).toBe('true');

  fireEvent.click(toggle);

  expect(toggle.getAttribute('aria-checked')).toBe('false');
  await waitFor(() =>
    expect(sent).toEqual([{ url: '/api/settings/members/assistant', body: { enabled: false } }]),
  );
});

it('puts the default back and says why in a toast when a save fails', async () => {
  stubFailingSaves('Could not save.');
  render(h(AssistantDefaultPanel, { access: INSTANCE_DEFAULT }));
  const toggle = screen.getByRole('switch', { name: 'Assistant for Members' });

  fireEvent.click(toggle);

  await waitFor(() =>
    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'error', message: 'Could not save.' }),
    ]),
  );
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(screen.queryByRole('status')).toBeNull();
});

it("says why in a toast when a Member's save fails", async () => {
  stubFailingSaves('Member not found.');
  render(memberCards({}));

  fireEvent.click(memberSwitch());

  await waitFor(() =>
    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'error', message: 'Member not found.' }),
    ]),
  );
  expect(memberSwitch().getAttribute('aria-checked')).toBe('true');
});

it('shows a Member without values of their own on the default, and moves them with it', () => {
  const { rerender } = render(memberCards({}));
  expect(memberSwitch().getAttribute('aria-checked')).toBe('true');
  expect(memberAllowance().value).toBe('30');
  expect(within(note(memberSwitch())).getByText('Default')).toBeTruthy();
  expect(within(note(memberAllowance())).getByText('Default')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Use default/ })).toBeNull();

  rerender(memberCards({}, { enabled: false, dailyMessages: 12 }));

  expect(memberSwitch().getAttribute('aria-checked')).toBe('false');
  expect(memberAllowance().value).toBe('12');
});

it("keeps a Member's own allowance when the default moves, and marks it as theirs", () => {
  const { rerender } = render(memberCards({ dailyMessages: 5 }));
  expect(within(note(memberAllowance())).getByText(/Set for this Member/)).toBeTruthy();
  expect(within(note(memberSwitch())).getByText('Default')).toBeTruthy();

  rerender(memberCards({ dailyMessages: 5 }, { enabled: false, dailyMessages: 12 }));

  expect(memberAllowance().value).toBe('5');
  expect(memberSwitch().getAttribute('aria-checked')).toBe('false');
});

it('switches the Assistant off for one Member', async () => {
  const sent = stubSaves({ enabled: false });
  render(memberCards({}));

  fireEvent.click(memberSwitch());

  await waitFor(() =>
    expect(sent).toEqual([
      { url: '/api/settings/members/member-1/assistant', body: { enabled: false } },
    ]),
  );
  expect(memberSwitch().getAttribute('aria-checked')).toBe('false');
  expect(within(note(memberSwitch())).getByText(/Set for this Member/)).toBeTruthy();
});

it("saves a Member's typed allowance when the field is left", async () => {
  const sent = stubSaves({ dailyMessages: 5 });
  render(memberCards({}));

  fireEvent.change(memberAllowance(), { target: { value: '5' } });
  fireEvent.blur(memberAllowance());

  await waitFor(() =>
    expect(sent).toEqual([
      { url: '/api/settings/members/member-1/assistant', body: { dailyMessages: 5 } },
    ]),
  );
  expect(within(note(memberAllowance())).getByText(/Set for this Member/)).toBeTruthy();
});

it('names the range and saves nothing when the typed allowance is outside it', () => {
  const sent = stubSaves({});
  render(memberCards({}));

  fireEvent.change(memberAllowance(), { target: { value: '0' } });
  fireEvent.blur(memberAllowance());

  expect(screen.getByText('Enter a whole number from 1 to 1000.')).toBeTruthy();
  expect(sent).toEqual([]);
});

it("takes one of a Member's values back to the default", async () => {
  const sent = stubSaves({ dailyMessages: 5 });
  render(memberCards({ enabled: false, dailyMessages: 5 }));

  fireEvent.click(
    within(note(memberSwitch())).getByRole('button', { name: 'Use default for Assistant' }),
  );

  await waitFor(() =>
    expect(sent).toEqual([
      { url: '/api/settings/members/member-1/assistant', body: { enabled: null } },
    ]),
  );
  expect(memberSwitch().getAttribute('aria-checked')).toBe('true');
  expect(within(note(memberSwitch())).getByText('Default')).toBeTruthy();
  expect(memberAllowance().value).toBe('5');
});
