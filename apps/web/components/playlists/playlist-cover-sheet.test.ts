// @vitest-environment jsdom

// The cover sheet's style list, and its per-attempt "Use People reference
// photos" switch: it rides one Generate press, never persists, and is only
// offered when the owner has a Person who could actually appear.

import { createElement as h } from 'react';
import type { SessionCoverGenerationRow } from '@liedmotif/db';
import { COVER_STYLE_CHOICES, type PlaylistSummaryItem } from '@liedmotif/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  playlistCoverStatus,
  regeneratePlaylistCover,
  type PlaylistCoverStatusData,
} from '@/lib/api-client';
import { coverFailureMessage } from '@/lib/cover-regeneration';
import { COVER_STYLE_LABELS } from '@/lib/cover-styles';
import { AppChromeContext, type AppChromeContextValue } from '@/components/app-chrome-context';
import { PlaylistCoverSheet } from './playlist-cover-sheet';

vi.mock('@/lib/api-client', () => ({
  playlistCoverStatus: vi.fn(),
  regeneratePlaylistCover: vi.fn(),
  selectPlaylistCover: vi.fn(),
  deletePlaylistCover: vi.fn(),
  uploadPlaylistCover: vi.fn(),
}));

const PLAYLIST = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Focus Nights',
  coverImageId: null,
  mosaicCoverImageIds: [],
} as unknown as PlaylistSummaryItem;

const STATUS: PlaylistCoverStatusData = {
  coverImageId: null,
  generating: false,
  latestRegeneration: null,
  usage: {
    usedDay: 0,
    limitDay: 10,
    usedMonth: 0,
    limitMonth: 50,
    remaining: 10,
    oneTime: false,
    enabled: true,
    providerConfigured: true,
    sunoFallbackActive: false,
  },
  history: [],
  peopleReferencesAvailable: true,
  promptEnhancement: { llmConfigured: false, active: false },
};

const CHROME: AppChromeContextValue = {
  listener: { name: 'Test', email: 'test@example.test', artistName: null, imageUrl: null },
  viewerRole: 'admin',
  ownVoiceOffered: false,
  themeMode: 'night',
  onToggleThemeMode: () => {},
  fetchChrome: () => new Promise(() => {}),
};

function sheet(open: boolean) {
  return h(
    AppChromeContext.Provider,
    { value: CHROME },
    h(PlaylistCoverSheet, { playlist: PLAYLIST, open, onClose: vi.fn(), onCoverChanged: vi.fn() }),
  );
}

async function renderSheet(overrides: Partial<PlaylistCoverStatusData> = {}) {
  vi.mocked(playlistCoverStatus).mockResolvedValue({
    ok: true,
    data: { ...STATUS, ...overrides },
  });
  vi.mocked(regeneratePlaylistCover).mockResolvedValue({
    ok: true,
    data: { outcome: 'started', coverGenerationId: 'cover-generation-1' },
  });
  const view = render(sheet(true));
  await screen.findByTestId('playlist-cover-generate');
  await waitFor(() => expect(playlistCoverStatus).toHaveBeenCalled());
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe('PlaylistCoverSheet — cover style', () => {
  // The open Select scrolls its selected option into view, which jsdom lacks.
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  // A Playlist has no prompt for Auto to pick a style from (ADR 0007).
  it('the Playlist cover sheet offers every style except Auto and opens on Random', async () => {
    await renderSheet();
    const trigger = screen.getByTestId('playlist-cover-style');
    expect(trigger.textContent).toContain(COVER_STYLE_LABELS.random);
    fireEvent.click(screen.getByTestId('playlist-cover-generate'));
    await waitFor(() =>
      expect(regeneratePlaylistCover).toHaveBeenCalledWith({
        playlistId: PLAYLIST.id,
        coverStyle: 'random',
      }),
    );

    fireEvent.keyDown(trigger, { key: 'Enter' });
    const options = (await screen.findAllByRole('option')).map((option) => option.textContent);
    expect(options).toEqual(
      COVER_STYLE_CHOICES.filter((choice) => choice !== 'auto').map(
        (choice) => COVER_STYLE_LABELS[choice],
      ),
    );
  });
});

describe('PlaylistCoverSheet — People reference photos', () => {
  it('starts off and sends the request flag only for that Generate press', async () => {
    await renderSheet();
    const toggle = screen.getByTestId('playlist-cover-use-people');
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(screen.getByTestId('playlist-cover-generate'));
    await waitFor(() =>
      expect(regeneratePlaylistCover).toHaveBeenCalledWith({
        playlistId: PLAYLIST.id,
        coverStyle: 'random',
      }),
    );

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('playlist-cover-generate'));
    await waitFor(() =>
      expect(regeneratePlaylistCover).toHaveBeenLastCalledWith({
        playlistId: PLAYLIST.id,
        coverStyle: 'random',
        usePeopleReferences: true,
      }),
    );
  });

  it('reopens the sheet with the switch back off', async () => {
    const { rerender } = await renderSheet();
    fireEvent.click(screen.getByTestId('playlist-cover-use-people'));

    for (const open of [false, true]) {
      rerender(sheet(open));
    }

    // Enabled again means the reopened sheet loaded its status, so the switch
    // state under test is the real one and not the pre-load placeholder.
    const toggle = await screen.findByTestId('playlist-cover-use-people');
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('disables the switch with a hint when no Person could appear', async () => {
    await renderSheet({ peopleReferencesAvailable: false });

    const toggle = screen.getByTestId('playlist-cover-use-people');
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Settings → People/)).toBeTruthy();

    fireEvent.click(screen.getByTestId('playlist-cover-generate'));
    await waitFor(() =>
      expect(regeneratePlaylistCover).toHaveBeenCalledWith({
        playlistId: PLAYLIST.id,
        coverStyle: 'random',
      }),
    );
  });

  // A refused toggle-on attempt is invisible otherwise: nothing lands in the
  // history, so the settled attempt's safe copy is the only thing that explains
  // it. The sheet must surface the server's wording, not summarize it.
  it.each([
    coverFailureMessage(
      { failureCategory: 'references_unsupported' } as SessionCoverGenerationRow,
      'admin',
    ),
    coverFailureMessage(
      { failureCategory: 'privacy_rejected' } as SessionCoverGenerationRow,
      'admin',
    ),
  ])('surfaces a settled refusal verbatim: %s', async (failureMessageSafe) => {
    await renderSheet({
      latestRegeneration: {
        coverGenerationId: 'cover-generation-1',
        coverImageId: 'cover-1',
        status: 'failed',
        failureMessageSafe,
      },
    });

    expect(screen.getByText(failureMessageSafe)).toBeTruthy();
  });
});
