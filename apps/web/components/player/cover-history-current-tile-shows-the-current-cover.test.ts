// @vitest-environment jsdom

import { createElement as h } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionCoverStatusData } from '@/lib/http/api-client';
import { SessionCoverSheet } from './session-cover-sheet';

const CURRENT = '11111111-1111-4111-8111-111111111111';
const FRESH = '22222222-2222-4222-8222-222222222222';
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
vi.mock('./cover-art', () => ({
  CoverArt: ({ coverImageId }: { coverImageId: string | null }) =>
    h('span', { 'data-cover-id': coverImageId }),
  CoverFallback: () => null,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function status(overrides: Partial<SessionCoverStatusData>): SessionCoverStatusData {
  return {
    coverImageId: CURRENT,
    coverStyle: 'auto',
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
    peopleReferencesAvailable: false,
    ...overrides,
  } as SessionCoverStatusData;
}

const READY = status({
  latestRegeneration: {
    coverGenerationId: GENERATION,
    coverImageId: FRESH,
    status: 'ready',
    failureMessageSafe: null,
  },
  history: [
    { coverImageId: FRESH, style: 'auto', createdAt: '2026-11-17T11:00:00.000Z', isCurrent: false },
    {
      coverImageId: CURRENT,
      style: 'auto',
      createdAt: '2026-11-17T10:00:00.000Z',
      isCurrent: true,
    },
  ],
});

function bigCoverId(): string | null {
  const sheet = screen.getByTestId('cover-sheet');
  const history = screen.getByTestId('cover-history');
  const big = [...sheet.querySelectorAll('[data-cover-id]')].find(
    (node) => !history.contains(node),
  );
  return big?.getAttribute('data-cover-id') ?? null;
}

it('tapping the current cover after a reroll shows it big, and the new cover stays one tap away', async () => {
  api.getSessionCoverStatus.mockResolvedValueOnce({ ok: true, data: status({}) });
  api.getSessionCoverStatus.mockResolvedValue({ ok: true, data: READY });
  api.regenerateSessionCover.mockResolvedValue({
    ok: true,
    data: { outcome: 'started', coverGenerationId: GENERATION },
  });

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

  await act(async () => {
    fireEvent.click(screen.getByTestId('cover-generate'));
  });
  await waitFor(() => expect(bigCoverId()).toBe(FRESH));
  expect(screen.getByLabelText(/Preview This Earlier/)).toHaveProperty('ariaPressed', 'true');

  fireEvent.click(screen.getByLabelText('Show the Current Cover'));
  expect(bigCoverId()).toBe(CURRENT);
  expect(screen.getByLabelText('Show the Current Cover')).toHaveProperty('ariaPressed', 'true');
  expect(screen.queryByTestId('cover-confirm')).toBeNull();

  fireEvent.click(screen.getByLabelText(/Preview This Earlier/));
  expect(bigCoverId()).toBe(FRESH);
  expect(screen.getByTestId('cover-confirm')).toBeTruthy();
});
