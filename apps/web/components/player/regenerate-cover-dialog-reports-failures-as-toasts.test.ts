// @vitest-environment jsdom

// The Reroll Cover Art dialog: a refused reroll, save or delete floats above the
// dialog, which stays open; a retry that lands clears it. How the dialog's own
// last attempt ended is what the dialog shows, so that stays in it.

import { createElement as h } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionCoverStatusData } from '@/lib/api-client';
import { shownToasts, toast } from '@/lib/toast';
import { RegenerateCoverDialog } from './regenerate-cover-dialog';

const CURRENT = '11111111-1111-4111-8111-111111111111';
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
vi.mock('./cover-art', () => ({ CoverArt: () => null, CoverFallback: () => null }));

afterEach(() => {
  toast.dismiss();
  cleanup();
  vi.clearAllMocks();
});

function status(overrides: Partial<SessionCoverStatusData> = {}): SessionCoverStatusData {
  return {
    coverImageId: CURRENT,
    coverStyle: 'auto',
    sessionPrompt: null,
    generating: false,
    latestRegeneration: null,
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
    history: [
      {
        coverImageId: CURRENT,
        style: 'auto',
        createdAt: '2026-11-17T10:00:00.000Z',
        isCurrent: true,
      },
    ],
    promptEnhancement: { llmConfigured: false, active: false },
    ...overrides,
  } as SessionCoverStatusData;
}

async function openDialog() {
  render(
    h(RegenerateCoverDialog, {
      open: true,
      onOpenChange: () => {},
      sessionId: 'session-1',
      sessionTitle: 'Night',
      coverImageId: CURRENT,
    }),
  );
  await waitFor(() => expect(api.getSessionCoverStatus).toHaveBeenCalled());
}

const reroll = () => act(async () => fireEvent.click(screen.getByTestId('regenerate-cover-start')));

it('floats a refused reroll above the dialog, and a reroll that starts clears it', async () => {
  api.getSessionCoverStatus.mockResolvedValue({ ok: true, data: status() });
  api.regenerateSessionCover
    .mockResolvedValueOnce({
      ok: false,
      error: { code: 'internal_error', message: 'The image provider is down.' },
    })
    .mockResolvedValueOnce({
      ok: true,
      data: { outcome: 'started', coverGenerationId: GENERATION },
    });
  await openDialog();

  await reroll();

  expect(shownToasts()).toEqual([
    expect.objectContaining({ tone: 'error', message: 'The image provider is down.' }),
  ]);
  expect(screen.queryByTestId('regenerate-cover-error')).toBeNull();
  expect(screen.getByTestId('regenerate-cover-dialog')).toBeTruthy();

  await reroll();

  expect(shownToasts()).toEqual([]);
});

it('keeps how its own attempt ended in the dialog, not in a toast', async () => {
  api.getSessionCoverStatus.mockResolvedValueOnce({ ok: true, data: status() });
  api.getSessionCoverStatus.mockResolvedValue({
    ok: true,
    data: status({
      latestRegeneration: {
        coverGenerationId: GENERATION,
        coverImageId: CURRENT,
        status: 'failed',
        failureMessageSafe: 'The cover could not be generated.',
      },
    }),
  });
  api.regenerateSessionCover.mockResolvedValue({
    ok: true,
    data: { outcome: 'started', coverGenerationId: GENERATION },
  });
  await openDialog();

  await reroll();

  expect((await screen.findByTestId('regenerate-cover-error')).textContent).toBe(
    'The cover could not be generated.',
  );
  expect(shownToasts()).toEqual([]);
});
