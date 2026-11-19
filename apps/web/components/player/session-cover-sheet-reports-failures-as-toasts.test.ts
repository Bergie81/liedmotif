// @vitest-environment jsdom

// The Session cover sheet: a refused reroll, save or delete floats above the
// sheet, which stays open; a retry that lands clears it. How the sheet's own
// last attempt ended is what the sheet shows, so that stays in it.

import { createElement as h } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionCoverStatusData } from '@/lib/http/api-client';
import { shownToasts, toast } from '@/lib/toast';
import { SessionCoverSheet } from './session-cover-sheet';

const CURRENT = '11111111-1111-4111-8111-111111111111';
const GENERATION = '33333333-3333-4333-8333-333333333333';

const api = vi.hoisted(() => ({
  getSessionCoverStatus: vi.fn(),
  regenerateSessionCover: vi.fn(),
  selectSessionCover: vi.fn(),
  deleteSessionCover: vi.fn(),
  uploadSessionCover: vi.fn(),
}));
vi.mock('@/lib/http/api-client', () => api);
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

async function openSheet() {
  render(
    h(SessionCoverSheet, {
      open: true,
      onClose: () => {},
      sessionId: 'session-1',
      sessionTitle: 'Night',
      coverImageId: CURRENT,
    }),
  );
  await waitFor(() => expect(api.getSessionCoverStatus).toHaveBeenCalled());
}

const reroll = () => act(async () => fireEvent.click(screen.getByTestId('cover-generate')));

it('floats a refused reroll above the sheet, and a reroll that starts clears it', async () => {
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
  await openSheet();

  await reroll();

  expect(shownToasts()).toEqual([
    expect.objectContaining({ tone: 'error', message: 'The image provider is down.' }),
  ]);
  expect(screen.queryByTestId('cover-error')).toBeNull();
  expect(screen.getByTestId('cover-sheet')).toBeTruthy();

  await reroll();

  expect(shownToasts()).toEqual([]);
});

it('keeps how its own attempt ended in the sheet, not in a toast', async () => {
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
  await openSheet();

  await reroll();

  expect((await screen.findByTestId('cover-error')).textContent).toBe(
    'The cover could not be generated.',
  );
  expect(shownToasts()).toEqual([]);
});
