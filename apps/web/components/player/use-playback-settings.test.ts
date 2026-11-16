// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePlaybackSettings } from './use-playback-settings';

interface PendingRequest {
  path: string;
  method: string;
  body: unknown;
  respond(body: unknown): void;
}

function captureFetches(): PendingRequest[] {
  const requests: PendingRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (path: string, init?: RequestInit) =>
        new Promise((resolve) => {
          requests.push({
            path,
            method: init?.method ?? 'GET',
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
            respond: (body) => resolve({ json: async () => body }),
          });
        }),
    ),
  );
  return requests;
}

const SETTINGS = { blendEnabled: true, crossfadeSeconds: 6 };
const ok = (data: unknown) => ({ ok: true, data });
const failure = {
  ok: false,
  error: { code: 'internal_error', message: 'Settings write failed.', retryable: true },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('usePlaybackSettings blend toggle', () => {
  it('flips the live settings ref immediately and persists the choice', async () => {
    const requests = captureFetches();
    const { result } = renderHook(() => usePlaybackSettings({ read: true }));
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => requests[0]!.respond(ok(SETTINGS)));
    expect(result.current.blendEnabled).toBe(true);

    let outcome: string | null = null;
    await act(async () => {
      const pending = result.current.setBlendEnabled(false);
      // The ref is the engine's live gate: it must flip before the write lands.
      expect(result.current.settingsRef.current.blendEnabled).toBe(false);
      expect(requests).toHaveLength(2);
      requests[1]!.respond(ok({ ...SETTINGS, blendEnabled: false }));
      outcome = await pending;
    });

    expect(outcome).toBeNull();
    expect(requests[1]).toMatchObject({
      path: '/api/settings/playback',
      method: 'POST',
      body: { blendEnabled: false },
    });
    expect(result.current.blendEnabled).toBe(false);
    expect(result.current.settingsRef.current).toEqual({
      blendEnabled: false,
      crossfadeSeconds: 6,
    });
  });

  it('reverts the flip and reports the failure when the write does not land', async () => {
    const requests = captureFetches();
    const { result } = renderHook(() => usePlaybackSettings({ read: true }));
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => requests[0]!.respond(ok(SETTINGS)));

    let outcome: string | null = null;
    await act(async () => {
      const pending = result.current.setBlendEnabled(false);
      requests[1]!.respond(failure);
      outcome = await pending;
    });

    expect(outcome).toContain('Settings write failed.');
    expect(result.current.blendEnabled).toBe(true);
    expect(result.current.settingsRef.current.blendEnabled).toBe(true);
  });

  it('keeps a toggle made before the mount fetch answers', async () => {
    const requests = captureFetches();
    const { result } = renderHook(() => usePlaybackSettings({ read: true }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(result.current.blendSettled).toBe(false);

    await act(async () => {
      const pending = result.current.setBlendEnabled(false);
      requests[1]!.respond(ok({ ...SETTINGS, blendEnabled: false }));
      await pending;
    });
    expect(result.current.blendEnabled).toBe(false);

    // The mount GET was already out when the user toggled, so it answers with
    // the pre-toggle value. Landing last, it must not restore it.
    await act(async () => requests[0]!.respond(ok(SETTINGS)));

    expect(result.current.blendSettled).toBe(true);
    expect(result.current.blendEnabled).toBe(false);
    expect(result.current.settingsRef.current.blendEnabled).toBe(false);
    // The rest of the server's answer still lands.
    expect(result.current.settingsRef.current.crossfadeSeconds).toBe(6);
  });

  it('lets the newest toggle win when two writes overlap', async () => {
    const requests = captureFetches();
    const { result } = renderHook(() => usePlaybackSettings({ read: true }));
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => requests[0]!.respond(ok(SETTINGS)));

    await act(async () => {
      const first = result.current.setBlendEnabled(false);
      const second = result.current.setBlendEnabled(true);
      // The newer write answers first; the older one lands afterwards and must
      // not drag the gate back to the value the user already moved past.
      requests[2]!.respond(ok({ ...SETTINGS, blendEnabled: true }));
      requests[1]!.respond(ok({ ...SETTINGS, blendEnabled: false }));
      await Promise.all([first, second]);
    });

    expect(result.current.blendEnabled).toBe(true);
    expect(result.current.settingsRef.current.blendEnabled).toBe(true);
  });

  it('reverts a failed newest toggle to the server value, not to an earlier unsaved flip', async () => {
    const requests = captureFetches();
    const { result } = renderHook(() => usePlaybackSettings({ read: true }));
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => requests[0]!.respond(ok(SETTINGS)));

    await act(async () => {
      const first = result.current.setBlendEnabled(false);
      const second = result.current.setBlendEnabled(true);
      requests[1]!.respond(failure);
      requests[2]!.respond(failure);
      await Promise.all([first, second]);
    });

    expect(result.current.blendEnabled).toBe(true);
    expect(result.current.settingsRef.current.blendEnabled).toBe(true);
  });

  it('lets the mount fetch apply the saved value after a toggle that failed before it answered', async () => {
    const requests = captureFetches();
    const { result } = renderHook(() => usePlaybackSettings({ read: true }));
    await waitFor(() => expect(requests).toHaveLength(1));

    await act(async () => {
      const pending = result.current.setBlendEnabled(false);
      requests[1]!.respond(failure);
      await pending;
    });
    await act(async () => requests[0]!.respond(ok({ ...SETTINGS, blendEnabled: false })));

    expect(result.current.blendEnabled).toBe(false);
    expect(result.current.settingsRef.current.blendEnabled).toBe(false);
  });

  it('adopts the settings stored past the player, re-read without a write', async () => {
    const requests = captureFetches();
    const { result } = renderHook(() => usePlaybackSettings({ read: true }));
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => requests[0]!.respond(ok(SETTINGS)));

    await act(async () => {
      const pending = result.current.adoptStoredSettings();
      requests[1]!.respond(ok({ blendEnabled: false, crossfadeSeconds: 9 }));
      await pending;
    });

    expect(requests[1]).toMatchObject({ path: '/api/settings/playback', method: 'GET' });
    expect(result.current.blendEnabled).toBe(false);
    expect(result.current.settingsRef.current).toEqual({
      blendEnabled: false,
      crossfadeSeconds: 9,
    });

    // The adopted value is the one the server confirmed: a failed toggle falls back to it.
    await act(async () => {
      const pending = result.current.setBlendEnabled(true);
      requests[2]!.respond(failure);
      await pending;
    });
    expect(result.current.blendEnabled).toBe(false);
    expect(result.current.settingsRef.current.blendEnabled).toBe(false);
  });

  it('keeps a toggle made while the re-read was out', async () => {
    const requests = captureFetches();
    const { result } = renderHook(() => usePlaybackSettings({ read: true }));
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => requests[0]!.respond(ok(SETTINGS)));

    await act(async () => {
      const reread = result.current.adoptStoredSettings();
      const toggle = result.current.setBlendEnabled(false);
      requests[2]!.respond(ok({ ...SETTINGS, blendEnabled: false }));
      requests[1]!.respond(ok(SETTINGS));
      await Promise.all([reread, toggle]);
    });

    expect(result.current.blendEnabled).toBe(false);
    expect(result.current.settingsRef.current.blendEnabled).toBe(false);
  });

  it('keeps a toggle already out when the re-read starts, taking the rest from the read', async () => {
    const requests = captureFetches();
    const { result } = renderHook(() => usePlaybackSettings({ read: true }));
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => requests[0]!.respond(ok(SETTINGS)));

    await act(async () => {
      const toggle = result.current.setBlendEnabled(false);
      const reread = result.current.adoptStoredSettings();
      // The read lands before the toggle's write commits, so it still says On.
      requests[2]!.respond(ok({ blendEnabled: true, crossfadeSeconds: 9 }));
      requests[1]!.respond(ok({ blendEnabled: false, crossfadeSeconds: 9 }));
      await Promise.all([reread, toggle]);
    });

    expect(result.current.blendEnabled).toBe(false);
    expect(result.current.settingsRef.current).toEqual({
      blendEnabled: false,
      crossfadeSeconds: 9,
    });
  });

  it('keeps the re-read settings when the mount fetch answers after it', async () => {
    const requests = captureFetches();
    const { result } = renderHook(() => usePlaybackSettings({ read: true }));
    await waitFor(() => expect(requests).toHaveLength(1));

    await act(async () => {
      const reread = result.current.adoptStoredSettings();
      requests[1]!.respond(ok({ blendEnabled: false, crossfadeSeconds: 9 }));
      await reread;
    });
    await act(async () => requests[0]!.respond(ok(SETTINGS)));

    expect(result.current.blendEnabled).toBe(false);
    expect(result.current.settingsRef.current).toEqual({
      blendEnabled: false,
      crossfadeSeconds: 9,
    });
  });

  // The Offline Library cannot read the owner's choice from the server, so it
  // plays the settings this device last read: blending off stays off offline.
  it('plays offline with the settings this device last read, without a request', async () => {
    const requests = captureFetches();
    const online = renderHook(() => usePlaybackSettings({ read: true }));
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => requests[0]!.respond(ok({ blendEnabled: false, crossfadeSeconds: 9 })));
    online.unmount();

    const { result } = renderHook(() => usePlaybackSettings({ read: false }));

    expect(requests).toHaveLength(1);
    expect(result.current.blendSettled).toBe(true);
    expect(result.current.blendEnabled).toBe(false);
    expect(result.current.settingsRef.current).toEqual({
      blendEnabled: false,
      crossfadeSeconds: 9,
    });
  });
});
