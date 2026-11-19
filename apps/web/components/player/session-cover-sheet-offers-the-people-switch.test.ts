// @vitest-environment jsdom

import { createElement as h } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionCoverStatusData } from '@/lib/http/api-client';
import { SessionCoverSheet } from './session-cover-sheet';

const CURRENT = '11111111-1111-4111-8111-111111111111';

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

const STATUS = {
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
  peopleReferencesAvailable: true,
} as SessionCoverStatusData;

async function renderSheet(status: SessionCoverStatusData = STATUS) {
  api.getSessionCoverStatus.mockResolvedValue({ ok: true, data: status });
  api.regenerateSessionCover.mockResolvedValue({
    ok: true,
    data: { outcome: 'started', coverGenerationId: '22222222-2222-4222-8222-222222222222' },
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
}

const generate = () => act(async () => fireEvent.click(screen.getByTestId('cover-generate')));
const sentRequest = () => api.regenerateSessionCover.mock.calls.at(-1)?.[1];

it('starts with People photos on, saying who they draw, and asks for them', async () => {
  await renderSheet();

  const toggle = screen.getByTestId('session-cover-use-people');
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(
    screen.getByText(
      'Draws the People named in this Session’s prompt or art direction — you when nobody is named, unless it runs without your profile details.',
    ),
  ).toBeTruthy();

  await generate();
  expect(sentRequest()).toMatchObject({ usePeopleReferences: true });
});

it('switched off, asks for no People photos', async () => {
  await renderSheet();

  fireEvent.click(screen.getByTestId('session-cover-use-people'));
  await generate();

  expect(sentRequest()).toMatchObject({ usePeopleReferences: false });
});

it('without a Person photo to use, the switch is off and nothing is asked for', async () => {
  await renderSheet({ ...STATUS, peopleReferencesAvailable: false });

  const toggle = screen.getByTestId('session-cover-use-people');
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(toggle.hasAttribute('disabled')).toBe(true);
  await generate();

  expect(sentRequest()).not.toHaveProperty('usePeopleReferences');
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

  const heading = screen.getByRole('heading', { name: 'Session Cover Art: Night' });
  expect(heading.querySelector('.text-lamp')?.textContent).toBe('Night');
  expect(screen.queryByTestId('cover-mosaic')).toBeNull();
});
