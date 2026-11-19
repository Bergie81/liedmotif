// @vitest-environment jsdom

import { createElement as h } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionCoverStatusData } from '@/lib/api-client';
import { SessionCoverSheet } from './session-cover-sheet';

const CURRENT = '11111111-1111-4111-8111-111111111111';

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
  cleanup();
  vi.clearAllMocks();
});

const STATUS = {
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
} as SessionCoverStatusData;

it('the cover sheet says that naming someone from People puts their photo on the cover', async () => {
  api.getSessionCoverStatus.mockResolvedValue({ ok: true, data: STATUS });

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

  expect(screen.getByTestId('session-cover-guidance')).toBeTruthy();
  expect(
    screen.getByText('Name someone from People to put their photo on the cover.'),
  ).toBeTruthy();
});

it('heads the sheet with the Session it covers, and offers no Mosaic View', async () => {
  api.getSessionCoverStatus.mockResolvedValue({ ok: true, data: STATUS });

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

  const heading = screen.getByRole('heading', { name: 'Session Cover: Night' });
  expect(heading.querySelector('.text-lamp')?.textContent).toBe('Night');
  expect(screen.queryByTestId('cover-mosaic')).toBeNull();
});
