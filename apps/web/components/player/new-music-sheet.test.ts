// @vitest-environment jsdom
import { createElement as h, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@liedmotif/shared';
import { AppChromeContext, type AppChromeContextValue } from '@/components/app-chrome-context';
import type { ChromeData } from '@/lib/api-client';
import { NewMusicSheet } from './new-music-sheet';
import { presentNewMusicStatus } from './new-music-status';

const session: SessionSummary = {
  id: '00000000-0000-4000-8000-000000000001',
  status: 'active',
  title: 'Calm',
  createdAt: '2026-09-13T10:00:00Z',
  updatedAt: '2026-09-13T10:00:00Z',
  generationStatus: 'ok',
  generationStatusScope: null,
  sessionMode: 'keep_going',
  coverImageId: null,
  statusMessageSafe: null,
  targetDurationMinutes: 60,
  generatedDurationSeconds: 720,
  unknownDurationTrackCount: 0,
};
const off: SessionSummary = { ...session, sessionMode: 'repeat', targetDurationMinutes: null };

const BOUNDED_USAGE: ChromeData['usage'] = {
  dailyTracksUsed: 62,
  dailyTracksLimit: 100,
  monthlyTracksUsed: 62,
  monthlyTracksLimit: 1000,
  minHeadroomTracksToStartSession: 2,
  budgetKind: 'rolling',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Reply = { ok: true; data: { session: SessionSummary } } | { ok: false; error: object };

/** Answers each write in turn, recording what the player asked for. */
function stubWrites(...replies: Reply[]) {
  const writes: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    writes.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    return { json: async () => replies[writes.length - 1] };
  });
  return writes;
}

const accepted = (s: SessionSummary): Reply => ({ ok: true, data: { session: s } });
const refused: Reply = {
  ok: false,
  error: { code: 'internal_error', message: 'Could not save.', retryable: true },
};

function wrap(usage: ChromeData['usage'] | null, children: ReactNode) {
  const fetchChrome = async () =>
    usage
      ? { ok: true as const, data: { usage, activeSession: null } }
      : {
          ok: false as const,
          error: { code: 'internal_error' as const, message: 'x', retryable: true },
        };
  return h(
    AppChromeContext.Provider,
    { value: { fetchChrome } as unknown as AppChromeContextValue },
    children,
  );
}

async function openSheet({
  current = session,
  available = true,
  usage = BOUNDED_USAGE,
}: {
  current?: SessionSummary;
  available?: boolean;
  usage?: ChromeData['usage'] | null;
} = {}) {
  const onSessionChange = vi.fn();
  const onOpenChange = vi.fn();
  const status = presentNewMusicStatus({
    session: current,
    generatingAhead: 0,
    generationStatus: 'ok',
  });
  const view = render(
    wrap(
      usage,
      h(NewMusicSheet, {
        open: true,
        onOpenChange,
        onSessionChange,
        available,
        status,
        session: current,
      }),
    ),
  );
  await act(async () => {});
  return { onSessionChange, onOpenChange, unmount: view.unmount };
}

const choice = (name: RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;
const OFF = /^Off/;
const UP_TO = /^Up to a duration/;
const NO_LIMIT = /^No limit/;
const saveButton = () => screen.queryByRole('button', { name: /^Save/ });
const press = (button: HTMLElement) => act(async () => fireEvent.click(button));

describe('choosing how much new music a Session may buy', () => {
  it('applies Off at once, with no Save to press', async () => {
    const stopped = { ...session, sessionMode: 'repeat' as const };
    const writes = stubWrites(accepted(stopped));
    const { onSessionChange, onOpenChange } = await openSheet();

    expect(choice(UP_TO).getAttribute('aria-pressed')).toBe('true');
    await press(choice(OFF));

    expect(writes).toEqual([
      { url: '/api/sessions/mode', body: { sessionId: session.id, mode: 'repeat' } },
    ]);
    expect(onSessionChange).toHaveBeenCalledWith(stopped);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('writes nothing that can spend until Save is pressed', async () => {
    const on = { ...off, sessionMode: 'keep_going' as const };
    const writes = stubWrites(accepted(on));
    const { onSessionChange, onOpenChange } = await openSheet({ current: off });

    expect(saveButton()).toBeNull();
    await press(choice(NO_LIMIT));
    expect(writes).toEqual([]);
    expect(choice(NO_LIMIT).getAttribute('aria-pressed')).toBe('true');

    await press(screen.getByRole('button', { name: 'Save · no limit' }));

    expect(writes).toEqual([
      {
        url: '/api/sessions/duration',
        body: { sessionId: session.id, targetDurationMinutes: null, sessionMode: 'keep_going' },
      },
    ]);
    expect(onSessionChange).toHaveBeenCalledWith(on);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('offers no Save for the choice already in force', async () => {
    await openSheet();
    await press(choice(NO_LIMIT));
    expect(saveButton()).not.toBeNull();
    await press(choice(UP_TO));
    expect(saveButton()).toBeNull();
  });

  it('saves a raised target in one write', async () => {
    const raised = { ...session, targetDurationMinutes: 70 };
    const writes = stubWrites(accepted(raised));
    const { onSessionChange } = await openSheet();

    fireEvent.change(screen.getByRole('slider'), { target: { value: '70' } });
    await press(screen.getByRole('button', { name: 'Save · up to 70 min' }));

    expect(writes).toEqual([
      {
        url: '/api/sessions/duration',
        body: { sessionId: session.id, targetDurationMinutes: 70, sessionMode: 'keep_going' },
      },
    ]);
    expect(onSessionChange).toHaveBeenCalledWith(raised);
  });

  it('turns an Off Session on up to a duration, starting from its kept target', async () => {
    const keptTarget = { ...off, targetDurationMinutes: 40 };
    const on = { ...keptTarget, sessionMode: 'keep_going' as const };
    const writes = stubWrites(accepted(on));
    await openSheet({ current: keptTarget });

    await press(choice(UP_TO));
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('40 min');
    await press(screen.getByRole('button', { name: 'Save · up to 40 min' }));

    expect(writes.map((write) => write.url)).toEqual(['/api/sessions/duration']);
  });

  it.each([
    ['on with a target', session],
    ['off with a kept target', { ...off, targetDurationMinutes: 40 }],
  ])('takes No limit in one write from a Session %s', async (_state, current) => {
    const writes = stubWrites(accepted({ ...off, sessionMode: 'keep_going' }));
    await openSheet({ current });

    await press(choice(NO_LIMIT));
    await press(screen.getByRole('button', { name: 'Save · no limit' }));

    expect(writes).toEqual([
      {
        url: '/api/sessions/duration',
        body: { sessionId: session.id, targetDurationMinutes: null, sessionMode: 'keep_going' },
      },
    ]);
  });

  it('cannot be dismissed while a save is under way, so its result is never lost', async () => {
    const stopped = { ...session, sessionMode: 'repeat' as const };
    let release: (value: unknown) => void = () => undefined;
    vi.stubGlobal('fetch', () => new Promise((resolve) => (release = resolve)));
    const { onSessionChange, onOpenChange } = await openSheet();

    await press(choice(OFF));
    expect(
      (screen.getByRole('button', { name: 'Close New music' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => release({ json: async () => accepted(stopped) }));

    expect(onSessionChange).toHaveBeenCalledWith(stopped);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows a refused Off in the open sheet and goes back to what is in force', async () => {
    stubWrites(refused);
    const { onSessionChange, onOpenChange } = await openSheet();

    await press(choice(OFF));

    expect(screen.getByRole('alert').textContent).toBe('Could not save.');
    expect(onSessionChange).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(choice(UP_TO).getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps an exact target the slider cannot show, until it is deliberately moved', async () => {
    await openSheet({ current: { ...session, targetDurationMinutes: 480 } });

    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('480 min');
    expect(saveButton()).toBeNull();
  });

  it('never lets the duration slider mean No limit', async () => {
    await openSheet();

    fireEvent.change(screen.getByRole('slider'), { target: { value: '0' } });

    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('5 min');
  });

  it('holds every choice while the player may not write the Session', async () => {
    const writes = stubWrites();
    await openSheet({ available: false });

    expect(choice(OFF).disabled).toBe(true);
    expect(choice(NO_LIMIT).disabled).toBe(true);
    await press(choice(OFF));
    expect(writes).toEqual([]);
  });

  it('drops a reply that arrives after the player moved to another Session', async () => {
    let release: (value: unknown) => void = () => undefined;
    vi.stubGlobal('fetch', () => new Promise((resolve) => (release = resolve)));
    const { onSessionChange, unmount } = await openSheet();

    await press(choice(OFF));
    unmount();
    await act(async () =>
      release({ json: async () => accepted({ ...session, sessionMode: 'repeat' }) }),
    );

    expect(onSessionChange).not.toHaveBeenCalled();
  });
});

describe('what the sheet says about spending', () => {
  const dialogText = () =>
    within(screen.getByRole('dialog')).getByTestId('new-music-facts').textContent;

  it('states what is happening and that it only generates while listening', async () => {
    await openSheet();
    expect(screen.getByText(/Nothing is being bought right now/)).toBeTruthy();
    expect(dialogText()).toContain('Only generates while you listen.');
  });

  it('counts the minutes generated and the Tracks left today', async () => {
    await openSheet();
    expect(dialogText()).toContain('12 / 60 min generated · 38 Tracks left today');
  });

  it('names the month when the monthly limit is the one binding', async () => {
    await openSheet({ usage: { ...BOUNDED_USAGE, monthlyTracksUsed: 990 } });
    expect(dialogText()).toContain('10 Tracks left this month');
  });

  it('names no period for a One-time budget', async () => {
    await openSheet({
      usage: {
        ...BOUNDED_USAGE,
        dailyTracksUsed: 90,
        dailyTracksLimit: 100,
        monthlyTracksUsed: 90,
        monthlyTracksLimit: 100,
        budgetKind: 'oneTime',
      },
    });
    expect(dialogText()).toContain('· 10 Tracks left');
    expect(dialogText()).not.toContain('today');
  });

  it('leaves the allowance out when no limit applies', async () => {
    await openSheet({
      usage: { ...BOUNDED_USAGE, dailyTracksLimit: null, monthlyTracksLimit: null },
    });
    expect(dialogText()).toContain('12 / 60 min generated');
    expect(dialogText()).not.toContain('left');
  });

  it('leaves the allowance out when the usage read fails', async () => {
    await openSheet({ usage: null });
    expect(dialogText()).toContain('12 / 60 min generated');
    expect(dialogText()).not.toContain('left');
  });
});
