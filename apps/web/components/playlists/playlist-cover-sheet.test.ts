// @vitest-environment jsdom

// The cover sheet's style list, and its per-attempt "Use People reference
// photos" switch: on by default whenever the owner has a Person who could
// actually appear, it rides one Generate press and never persists.

import { createElement as h } from 'react';
import type { SessionCoverGenerationRow } from '@liedmotif/db';
import {
  COVER_STYLE_CHOICES,
  MAX_PLAYLIST_COVER_HISTORY,
  type PlaylistSummaryItem,
} from '@liedmotif/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deletePlaylistCover,
  playlistCoverStatus,
  regeneratePlaylistCover,
  selectPlaylistCover,
  type PlaylistCoverStatusData,
} from '@/lib/http/api-client';
import { coverFailureMessage } from '@/lib/covers/cover-regeneration';
import { COVER_STYLE_LABELS } from '@/lib/covers/cover-styles';
import { AppChromeContext, type AppChromeContextValue } from '@/components/app-chrome-context';
import { PlaylistCoverSheet } from './playlist-cover-sheet';

vi.mock('@/lib/http/api-client', () => ({
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
};

const CHROME: AppChromeContextValue = {
  listener: { name: 'Test', email: 'test@example.test', artistName: null, imageUrl: null },
  viewerRole: 'admin',
  ownVoiceOffered: false,
  llmConfigured: false,
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

/** What the big stage shows: the current cover or a previewed candidate. */
function showing() {
  return screen.getByTestId('cover-stage').getAttribute('data-showing');
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
  await screen.findByTestId('cover-generate');
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
    fireEvent.click(screen.getByTestId('cover-generate'));
    await waitFor(() =>
      expect(regeneratePlaylistCover).toHaveBeenCalledWith(
        expect.objectContaining({ playlistId: PLAYLIST.id, coverStyle: 'random' }),
      ),
    );

    fireEvent.keyDown(trigger, { key: 'Enter' });
    // An option's name is its style label; the explanation beside it is its description.
    const options = (await screen.findAllByRole('option')).map(
      (option) =>
        document.getElementById(option.getAttribute('aria-labelledby') ?? '')?.textContent,
    );
    expect(options).toEqual(
      COVER_STYLE_CHOICES.filter((choice) => choice !== 'auto').map(
        (choice) => COVER_STYLE_LABELS[choice],
      ),
    );
  });
});

describe('PlaylistCoverSheet — People reference photos', () => {
  it('starts on when a Person could appear, and off asks for no photos on that Generate press', async () => {
    await renderSheet();
    const toggle = screen.getByTestId('playlist-cover-use-people');
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByTestId('cover-generate'));
    await waitFor(() =>
      expect(regeneratePlaylistCover).toHaveBeenCalledWith({
        playlistId: PLAYLIST.id,
        coverStyle: 'random',
        usePeopleReferences: true,
      }),
    );

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByTestId('cover-generate'));
    await waitFor(() =>
      expect(regeneratePlaylistCover).toHaveBeenLastCalledWith({
        playlistId: PLAYLIST.id,
        coverStyle: 'random',
        usePeopleReferences: false,
      }),
    );
  });

  it('reopens the sheet with the switch back on', async () => {
    const { rerender } = await renderSheet();
    fireEvent.click(screen.getByTestId('playlist-cover-use-people'));

    for (const open of [false, true]) {
      rerender(sheet(open));
    }

    // Enabled again means the reopened sheet loaded its status, so the switch
    // state under test is the real one and not the pre-load placeholder.
    const toggle = await screen.findByTestId('playlist-cover-use-people');
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('disables the switch with a hint when no Person could appear', async () => {
    await renderSheet({ peopleReferencesAvailable: false });

    const toggle = screen.getByTestId('playlist-cover-use-people');
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Settings → People/)).toBeTruthy();

    fireEvent.click(screen.getByTestId('cover-generate'));
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
  ])('surfaces a settled refusal of its own attempt verbatim: %s', async (failureMessageSafe) => {
    await renderSheet({
      latestRegeneration: {
        coverGenerationId: 'cover-generation-1',
        coverImageId: 'cover-1',
        status: 'failed',
        failureMessageSafe,
      },
    });
    expect(screen.queryByText(failureMessageSafe)).toBeNull();

    fireEvent.click(screen.getByTestId('cover-generate'));

    expect((await screen.findByTestId('cover-error')).textContent).toBe(failureMessageSafe);
  });
});

describe('PlaylistCoverSheet — cover cap', () => {
  function historyOf(count: number): PlaylistCoverStatusData['history'] {
    return Array.from({ length: count }, (_, i) => ({
      coverImageId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      isCurrent: i === 0,
      style: i % 2 === 0 ? 'minimal' : 'uploaded',
      createdAt: '2026-11-18T10:00:00.000Z',
    }));
  }

  it('at ten covers the sheet disables Upload and Generate and says to delete one first', async () => {
    const full = historyOf(MAX_PLAYLIST_COVER_HISTORY);
    await renderSheet({ history: full });

    expect(screen.getByTestId('cover-count').textContent).toBe(
      `${MAX_PLAYLIST_COVER_HISTORY}/${MAX_PLAYLIST_COVER_HISTORY}`,
    );
    expect((screen.getByTestId('cover-upload') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('cover-generate') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Delete a previous cover to make room/)).toBeTruthy();

    // Deleting one makes room again.
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete This Cover' });
    expect((deleteButtons[0] as HTMLButtonElement).disabled).toBe(false);
    vi.mocked(deletePlaylistCover).mockResolvedValue({
      ok: true,
      data: { coverImageId: full[1]!.coverImageId },
    });
    vi.mocked(playlistCoverStatus).mockResolvedValue({
      ok: true,
      data: { ...STATUS, history: full.slice(0, -1) },
    });
    fireEvent.click(deleteButtons[0]!);

    await waitFor(() =>
      expect((screen.getByTestId('cover-upload') as HTMLButtonElement).disabled).toBe(false),
    );
    expect((screen.getByTestId('cover-generate') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('cover-count').textContent).toBe(
      `${MAX_PLAYLIST_COVER_HISTORY - 1}/${MAX_PLAYLIST_COVER_HISTORY}`,
    );
    expect(screen.queryByText(/Delete a previous cover to make room/)).toBeNull();
  });

  it('a full history is named even while generating is blocked for another reason', async () => {
    await renderSheet({
      history: historyOf(MAX_PLAYLIST_COVER_HISTORY),
      usage: { ...STATUS.usage, providerConfigured: false },
    });

    expect((screen.getByTestId('cover-upload') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Delete a previous cover to make room/)).toBeTruthy();
    expect(screen.getByText(/No image provider is configured/)).toBeTruthy();
  });
});

describe('PlaylistCoverSheet — preview before applying', () => {
  const CURRENT = '00000000-0000-4000-8000-000000000001';
  const FRESH = '00000000-0000-4000-8000-000000000002';
  const EARLIER = '00000000-0000-4000-8000-000000000003';

  function entry(coverImageId: string, isCurrent = false) {
    return { coverImageId, isCurrent, style: 'minimal', createdAt: '2026-11-18T10:00:00.000Z' };
  }

  const READY = {
    coverImageId: CURRENT,
    history: [entry(FRESH), entry(CURRENT, true)],
    latestRegeneration: {
      coverGenerationId: 'cover-generation-1',
      coverImageId: FRESH,
      status: 'ready' as const,
      failureMessageSafe: null,
    },
  };

  /** Press Generate; the status the sheet then reads holds the finished attempt. */
  async function generateFresh() {
    await renderSheet(READY);
    fireEvent.click(screen.getByTestId('cover-generate'));
    await waitFor(() => expect(showing()).toBe('new'));
  }

  it('shows an attempt started in this sheet big beside the current cover and applies it only on confirm', async () => {
    vi.mocked(selectPlaylistCover).mockResolvedValue({ ok: true, data: { coverImageId: FRESH } });
    await generateFresh();

    expect(screen.getByTestId('cover-peek')).toBeTruthy();
    expect(selectPlaylistCover).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('cover-confirm'));
    await waitFor(() => expect(selectPlaylistCover).toHaveBeenCalledWith(PLAYLIST.id, FRESH));
  });

  it('keeps the chosen cover on the stage while the swap saves, never flashing the old one', async () => {
    const seen: (string | null)[] = [];
    vi.mocked(selectPlaylistCover).mockImplementation(async () => {
      seen.push(showing());
      vi.mocked(playlistCoverStatus).mockResolvedValue({
        ok: true,
        data: {
          ...STATUS,
          ...READY,
          coverImageId: FRESH,
          history: [entry(FRESH, true), entry(CURRENT)],
        },
      });
      return { ok: true, data: { coverImageId: FRESH } };
    });
    await generateFresh();
    const stage = screen.getByTestId('cover-stage');
    const observer = new MutationObserver(() => seen.push(showing()));
    observer.observe(stage, { attributes: true, attributeFilter: ['data-showing'] });

    fireEvent.click(screen.getByTestId('cover-confirm'));
    await waitFor(() => expect(screen.queryByTestId('cover-confirm')).toBeNull());
    observer.disconnect();

    expect(seen[0]).toBe('new');
    // The only switch is to the new current cover; the old one never returns.
    expect(seen.slice(1).every((value) => value === 'new' || value === 'current')).toBe(true);
    expect(stage.querySelector('img')?.getAttribute('src')).toContain(FRESH);
  });

  it('shows no status chip on the stage', async () => {
    await generateFresh();
    expect(screen.getByTestId('cover-stage').textContent).not.toMatch(/New|Preview/);
  });

  it('an unconfirmed attempt from an earlier open waits in Previous Covers instead of previewing', async () => {
    await renderSheet(READY);

    expect(showing()).toBe('current');
    expect(screen.queryByTestId('cover-confirm')).toBeNull();
    expect(screen.queryByTestId('cover-peek')).toBeNull();
    expect(screen.getByRole('button', { name: 'Preview This Earlier Cover' })).toBeTruthy();
  });

  it('keeping the current cover ends the preview without applying anything', async () => {
    await generateFresh();

    fireEvent.click(screen.getByTestId('cover-keep'));
    expect(screen.queryByTestId('cover-confirm')).toBeNull();
    expect(showing()).toBe('current');
    expect(selectPlaylistCover).not.toHaveBeenCalled();
  });

  it('tapping a previous cover previews it instead of applying it', async () => {
    vi.mocked(selectPlaylistCover).mockResolvedValue({ ok: true, data: { coverImageId: EARLIER } });
    await renderSheet({ coverImageId: CURRENT, history: [entry(CURRENT, true), entry(EARLIER)] });

    fireEvent.click(screen.getByRole('button', { name: 'Preview This Earlier Cover' }));
    expect(selectPlaylistCover).not.toHaveBeenCalled();
    expect(showing()).toBe('earlier');

    fireEvent.click(screen.getByTestId('cover-confirm'));
    await waitFor(() => expect(selectPlaylistCover).toHaveBeenCalledWith(PLAYLIST.id, EARLIER));
  });

  it('offers two lines for the art direction', async () => {
    await renderSheet();
    const field = screen.getByLabelText('Cover art direction');
    expect(field.tagName).toBe('TEXTAREA');
    expect(field.getAttribute('rows')).toBe('2');
  });
});

describe('PlaylistCoverSheet — header', () => {
  it('heads the sheet with the Playlist it covers, its name in the highlight color', async () => {
    await renderSheet();
    const heading = screen.getByRole('heading', { name: 'Playlist Cover Art: Focus Nights' });
    expect(heading.querySelector('.text-lamp')?.textContent).toBe('Focus Nights');
  });
});
