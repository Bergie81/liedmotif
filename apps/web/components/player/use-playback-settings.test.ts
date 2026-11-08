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
