// @vitest-environment jsdom

// The Change Vibe sheet's own-voice offer: a Member gets no Singer control and
// no Settings → My voice hint, and the admin-only `/api/settings/voice` fetch
// never fires for them — the role half of the offer comes from the app-shell
// context; only an Admin asks for profile readiness on open. One escape hatch:
// a Session already singing with own voice always shows the control so it can
// be turned off. An Admin on an instance with the switch off is treated as a
// Member (the queue's vibe never reports own voice there).

import { createElement as h, type ReactNode } from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionVibe } from '@liedmotif/shared';
import { AppChromeContext, type AppChromeContextValue } from '@/components/app-chrome-context';
import { ChangeVibeSheet } from './change-vibe-sheet';

// The sheet renders Radix sliders (the Guardrails fold), which measure their
// thumb — jsdom ships no ResizeObserver, so the mount needs a stub.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HINT_TEXT = /Settings → My Voice/;
const noop = () => {};

const VOCAL_VIBE: SessionVibe = {
  genreTags: [],
  energy: null,
  vocalMode: 'vocal',
  voiceGender: null,
  ownVoice: false,
  language: '',
  styleStrength: null,
  novelty: null,
  avoid: '',
  controls: null,
};

function chromeValue(
  viewerRole: 'admin' | 'member',
  ownVoiceOffered = viewerRole === 'admin',
): AppChromeContextValue {
  return {
    ownVoiceOffered,
    listener: { name: 'Test', email: 'test@example.test', artistName: null, imageUrl: null },
    themeMode: 'night',
    onToggleThemeMode: noop,
    fetchChrome: () => new Promise(() => {}),
    viewerRole,
  };
}

function profileEnvelope(availableForSessions: boolean) {
  return {
    ok: true,
    data: {
      profile: {
        status: availableForSessions ? 'ready' : 'none',
        displayName: 'My voice',
        language: '',
        verificationPhrase: null,
        errorMessageSafe: null,
        hasSourceRecording: false,
        hasVerificationRecording: false,
        setupSupported: true,
        generationSupported: true,
        availableForSessions,
      },
    },
  };
}

async function renderSheet({
  viewerRole,
  vibe = VOCAL_VIBE,
  availableForSessions = true,
  ownVoiceOffered = viewerRole === 'admin',
}: {
  viewerRole: 'admin' | 'member';
  vibe?: SessionVibe;
  availableForSessions?: boolean;
  ownVoiceOffered?: boolean;
}) {
  const fetchMock = vi.fn(async () => ({
    json: async () => profileEnvelope(availableForSessions),
  }));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => {
    render(
      h(
        AppChromeContext.Provider,
        { value: chromeValue(viewerRole, ownVoiceOffered) },
        h(ChangeVibeSheet, {
          vibe,
          disabled: false,
          switchNowLocked: false,
          triggerClassName: '',
          open: true,
          onOpenChange: noop,
          onSubmit: noop,
        }) as ReactNode,
      ),
    );
  });
  return fetchMock;
}

describe('ChangeVibeSheet own-voice offer', () => {
  it('member: no Singer control, no hint, and no /api/settings/voice fetch', async () => {
    const fetchMock = await renderSheet({ viewerRole: 'member' });
    expect(screen.queryByText('Singer')).toBeNull();
    expect(screen.queryByText(HINT_TEXT)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('admin with a usable profile: the Singer control renders', async () => {
    const fetchMock = await renderSheet({ viewerRole: 'admin', availableForSessions: true });
    expect(await screen.findByText('Singer')).toBeTruthy();
    expect(screen.queryByText(HINT_TEXT)).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/api/settings/voice', expect.anything());
  });

  it('admin without a usable profile: the hint renders instead', async () => {
    await renderSheet({ viewerRole: 'admin', availableForSessions: false });
    expect(await screen.findByText(HINT_TEXT)).toBeTruthy();
    expect(screen.queryByText('Singer')).toBeNull();
  });

  it('admin with the feature switched off: no Singer control, no hint, and no fetch', async () => {
    const fetchMock = await renderSheet({ viewerRole: 'admin', ownVoiceOffered: false });
    expect(screen.queryByText('Singer')).toBeNull();
    expect(screen.queryByText(HINT_TEXT)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('member on a session already singing with own voice: the control renders so it can be turned off', async () => {
    const fetchMock = await renderSheet({
      viewerRole: 'member',
      vibe: { ...VOCAL_VIBE, ownVoice: true },
    });
    expect(screen.getByText('Singer')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ChangeVibeSheet preselection', () => {
  it('opened before the vibe loaded, it preselects the vibe once it arrives, and a picks-only edit keeps the vocals and own voice', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const onSubmit = vi.fn();
    const sheet = (vibe: SessionVibe | null) =>
      h(
        AppChromeContext.Provider,
        { value: chromeValue('member') },
        h(ChangeVibeSheet, {
          vibe,
          disabled: true,
          switchNowLocked: false,
          triggerClassName: '',
          open: true,
          onOpenChange: noop,
          onSubmit,
        }) as ReactNode,
      );
    const ownVoiceVibe: SessionVibe = { ...VOCAL_VIBE, ownVoice: true };
    const view = render(sheet(null));
    await act(async () => view.rerender(sheet(ownVoiceVibe)));

    const dialog = screen.getByRole('dialog');
    const pressed = (name: string) =>
      within(dialog).getByRole('button', { name }).getAttribute('aria-pressed');
    expect(pressed('Vocals')).toBe('true');
    expect(pressed('My Voice')).toBe('true');

    act(() => within(dialog).getByRole('button', { name: 'High' }).click());
    act(() => within(dialog).getByRole('button', { name: 'Change Vibe' }).click());
    expect(onSubmit).toHaveBeenCalledWith(
      { mode: 'picks', energy: 'high' },
      { switchImmediately: false, targetDurationMinutes: undefined },
    );
  });
});
