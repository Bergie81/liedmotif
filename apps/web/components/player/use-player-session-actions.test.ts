// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { usePlayerSessionActions } from './use-player-session-actions';

vi.mock('@/lib/use-client-id', () => ({ useClientId: () => 'client-1' }));
vi.mock('./player-provider', () => ({
  usePlayerActions: () => ({ beginOtherMusic: async () => true }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PLAYLIST_ID = '00000000-0000-4000-8000-000000000900';

function renderActions(body: unknown) {
  const fetcher = vi.fn(async (_url: string) => ({ json: async () => body }));
  vi.stubGlobal('fetch', fetcher);
  const onConverted = vi.fn();
  const { result } = renderHook(() =>
    usePlayerSessionActions({
      sessionId: 'session-1',
      trackId: 'track-1',
      onSessionChange: vi.fn(),
      onStopped: vi.fn(),
      onConverted,
    }),
  );
  return { result, fetcher, onConverted };
}

it('hands over the new Playlist once the Session is converted', async () => {
  const { result, fetcher, onConverted } = renderActions({
    ok: true,
    data: { playlistId: PLAYLIST_ID, trackCount: 3 },
  });
  await act(() => result.current.convertToPlaylist());
  expect(fetcher.mock.calls[0]![0]).toBe('/api/sessions/convert-to-playlist');
  expect(onConverted).toHaveBeenCalledWith(PLAYLIST_ID);
  expect(result.current.error).toBeNull();
});

it('says why when the conversion is refused', async () => {
  const { result, onConverted } = renderActions({
    ok: false,
    error: {
      code: 'validation_error',
      message: 'This Session has no Tracks yet.',
      retryable: false,
    },
  });
  await act(() => result.current.convertToPlaylist());
  expect(onConverted).not.toHaveBeenCalled();
  expect(result.current.error?.message).toBe(
    'Convert to Playlist failed: This Session has no Tracks yet.',
  );
});

it('mints one Playlist for two quick taps', async () => {
  const { result, fetcher } = renderActions({
    ok: true,
    data: { playlistId: PLAYLIST_ID, trackCount: 3 },
  });
  await act(async () => {
    await Promise.all([result.current.convertToPlaylist(), result.current.convertToPlaylist()]);
  });
  expect(fetcher).toHaveBeenCalledOnce();
});
