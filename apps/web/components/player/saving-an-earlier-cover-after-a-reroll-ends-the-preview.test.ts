// @vitest-environment jsdom

import { createElement as h } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionCoverStatusData } from '@/lib/api-client';
import { shownToasts, toast } from '@/lib/toast';
import { RegenerateCoverDialog } from './regenerate-cover-dialog';

const CURRENT = '11111111-1111-4111-8111-111111111111';
const FRESH = '22222222-2222-4222-8222-222222222222';
const OLDER = '44444444-4444-4444-8444-444444444444';
const GENERATION = '33333333-3333-4333-8333-333333333333';

const api = vi.hoisted(() => ({
  getSessionCoverStatus: vi.fn(),
  regenerateSessionCover: vi.fn(),
  selectSessionCover: vi.fn(),
  deleteSessionCover: vi.fn(),
  uploadSessionCover: vi.fn(),
}));
vi.mock('@/lib/api-client', () => api);
vi.mock('@/components/app-chrome-context', () => ({
  useAppChrome: () => ({ viewerRole: 'admin' }),
}));
vi.mock('@/components/media/use-image-crop-picker', () => ({
  useImageCropPicker: () => ({ busy: false, pick: () => {}, element: null }),
}));
vi.mock('./cover-art', () => ({
  CoverArt: ({ coverImageId }: { coverImageId: string | null }) =>
    h('span', { 'data-cover-id': coverImageId }),
  CoverFallback: () => null,
}));

afterEach(() => {
  toast.dismiss();
  cleanup();
  vi.clearAllMocks();
});

/** The server side of the dialog: which cover is current and whether the reroll landed. */
function serveCovers() {
  const server = { current: CURRENT, rerolled: false };
  api.getSessionCoverStatus.mockImplementation(async () => {
    const ids = server.rerolled ? [FRESH, OLDER, CURRENT] : [OLDER, CURRENT];
    const data = {
      coverImageId: server.current,
      coverStyle: 'auto',
      sessionPrompt: null,
      generating: false,
      latestRegeneration: server.rerolled
        ? {
            coverGenerationId: GENERATION,
            coverImageId: FRESH,
            status: 'ready',
            failureMessageSafe: null,
          }
        : null,
      usage: {
        usedDay: 0,
        limitDay: null,
        usedMonth: 0,
        limitMonth: null,
        remaining: null,
        oneTime: false,
        enabled: true,
        providerConfigured: true,
        sunoFallbackActive: false,
      },
      history: ids.map((coverImageId, index) => ({
        coverImageId,
        style: 'auto',
        createdAt: `2026-11-17T1${3 - index}:00:00.000Z`,
        isCurrent: coverImageId === server.current,
      })),
      promptEnhancement: { llmConfigured: false, active: false },
    } as SessionCoverStatusData;
    return { ok: true, data };
  });
  api.regenerateSessionCover.mockImplementation(async () => {
    server.rerolled = true;
    return { ok: true, data: { outcome: 'started', coverGenerationId: GENERATION } };
  });
  api.selectSessionCover.mockImplementation(async (_sessionId: string, coverImageId: string) => {
    server.current = coverImageId;
    return { ok: true, data: { coverImageId } };
  });
  return server;
}

function bigCoverId(): string | null {
  const dialog = screen.getByTestId('regenerate-cover-dialog');
  const history = screen.getByTestId('cover-history');
  const big = [...dialog.querySelectorAll('[data-cover-id]')].find(
    (node) => !history.contains(node),
  );
  return big?.getAttribute('data-cover-id') ?? null;
}

function historyTile(coverImageId: string): HTMLElement {
  const tile = screen
    .getByTestId('cover-history')
    .querySelector(`[data-cover-id="${coverImageId}"]`)
    ?.closest('button');
  if (!tile) throw new Error(`no history tile for ${coverImageId}`);
  return tile;
}

async function rerollAndPickOlder() {
  render(
    h(RegenerateCoverDialog, {
      open: true,
      onOpenChange: () => {},
      sessionId: 'session-1',
      sessionTitle: 'Night',
      coverImageId: CURRENT,
    }),
  );
  await waitFor(() => expect(screen.queryByTestId('cover-history')).not.toBeNull());
  await act(async () => {
    fireEvent.click(screen.getByTestId('regenerate-cover-start'));
  });
  await waitFor(() => expect(bigCoverId()).toBe(FRESH));
  fireEvent.click(historyTile(OLDER));
  expect(bigCoverId()).toBe(OLDER);
}

it('saving an earlier cover after a reroll ends the preview', async () => {
  serveCovers();
  await rerollAndPickOlder();

  await act(async () => {
    fireEvent.click(screen.getByTestId('regenerate-cover-confirm'));
  });

  await waitFor(() =>
    expect(historyTile(OLDER).getAttribute('aria-label')).toBe('Show the current cover'),
  );
  expect(bigCoverId()).toBe(OLDER);
  expect(screen.queryByTestId('regenerate-cover-confirm')).toBeNull();
  expect(screen.queryByTestId('regenerate-cover-dismiss')).toBeNull();
});

it('the fresh cover that was not chosen stays in the history and can still be saved', async () => {
  serveCovers();
  await rerollAndPickOlder();
  await act(async () => {
    fireEvent.click(screen.getByTestId('regenerate-cover-confirm'));
  });
  await waitFor(() => expect(screen.queryByTestId('regenerate-cover-confirm')).toBeNull());

  fireEvent.click(historyTile(FRESH));
  expect(bigCoverId()).toBe(FRESH);
  await act(async () => {
    fireEvent.click(screen.getByTestId('regenerate-cover-confirm'));
  });

  expect(api.selectSessionCover).toHaveBeenLastCalledWith('session-1', FRESH);
  await waitFor(() =>
    expect(historyTile(FRESH).getAttribute('aria-label')).toBe('Show the current cover'),
  );
  expect(bigCoverId()).toBe(FRESH);
  expect(screen.queryByTestId('regenerate-cover-confirm')).toBeNull();
});

it('a failed save keeps the preview and its buttons, and shows the error', async () => {
  serveCovers();
  await rerollAndPickOlder();
  api.selectSessionCover.mockResolvedValueOnce({
    ok: false,
    error: { code: 'internal_error', message: 'The cover could not be saved.' },
  });

  await act(async () => {
    fireEvent.click(screen.getByTestId('regenerate-cover-confirm'));
  });

  expect(shownToasts()).toContainEqual(
    expect.objectContaining({ tone: 'error', message: 'The cover could not be saved.' }),
  );
  expect(bigCoverId()).toBe(OLDER);
  expect(screen.getByTestId('regenerate-cover-confirm')).toBeTruthy();
  expect(screen.getByTestId('regenerate-cover-dismiss')).toBeTruthy();
});
