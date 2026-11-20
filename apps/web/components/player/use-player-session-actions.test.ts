// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { usePlayerSessionActions } from './use-player-session-actions';

vi.mock('@/lib/use-client-id', () => ({ useClientId: () => 'client-1' }));
vi.mock('./player-provider', () => ({
  usePlayerActions: () => ({ beginOtherMusic: async () => true }),
}));

afterEach(() => {
  cleanup();
  toast.dismiss();
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
  expect(shownToasts()).toEqual([]);
});

it('says why when the conversion is refused', async () => {
  const { result, onConverted } = renderActions({
    ok: false,
    error: {
      code: 'validation_error',
      message: 'This session has no tracks yet.',
      retryable: false,
    },
  });
  await act(() => result.current.convertToPlaylist());
  expect(onConverted).not.toHaveBeenCalled();
  expect(shownToasts()).toEqual([
    expect.objectContaining({
      tone: 'error',
      message: 'Convert to Playlist failed: This session has no tracks yet.',
    }),
  ]);
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
