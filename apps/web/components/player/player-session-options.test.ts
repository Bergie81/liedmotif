// @vitest-environment jsdom

import { createElement as h } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { presentNewMusicStatus } from './new-music-status';
import { PlayerSessionOptions } from './player-session-options';

// Lazily loaded and needs the app shell: left real, it throws whenever its import
// settles before the test ends, which makes these tests depend on load timing.
vi.mock('./regenerate-cover-dialog', () => ({ RegenerateCoverDialog: () => null }));

afterEach(() => {
  cleanup();
});

const GENERATING = presentNewMusicStatus({
  session: {
    sessionMode: 'keep_going',
    targetDurationMinutes: 60,
    generatedDurationSeconds: 22 * 60,
    unknownDurationTrackCount: 0,
  },
  generatingAhead: 2,
  generationStatus: 'ok',
});

function Options({
  changeVibeAvailable = true,
  onConvertToPlaylist = () => {},
  onOpenNewMusic = () => {},
  onOpenLyrics = () => {},
  lyricsAvailable = false,
}: {
  changeVibeAvailable?: boolean;
  onConvertToPlaylist?: () => void;
  onOpenNewMusic?: () => void;
  onOpenLyrics?: () => void;
  lyricsAvailable?: boolean;
}) {
  const noop = () => {};
  const succeed = async () => null;
  const complete = async () => {};
  return h(PlayerSessionOptions, {
    sessionId: 'session-1',
    sessionTitle: 'Night',
    coverImageId: null,
    newMusicStatus: GENERATING,
    onOpenNewMusic,
    actionError: null,
    busy: false,
    onStop: noop,
    lyricsAvailable,
    onOpenLyrics,
    onOpenTrackData: noop,
    track: null,
    onConvertToPlaylist,
    onRenameSession: succeed,
    onRenameTrack: succeed,
    onReroll: noop,
    onMoreLikeThis: complete,
    moreLikeThisAvailable: true,
    onOpenChangeVibe: noop,
    changeVibeAvailable,
    onDeleteTrack: complete,
    onDeleteSession: complete,
    blendEnabled: true,
    onToggleBlend: noop,
    onAddTrackToPlaylist: noop,
    sleepTimerEndsAt: null,
    sectionLoop: { open: false, available: true, onToggle: () => {} },
  });
}

it('states the New music status in its row and hands over to the New music sheet', () => {
  const onOpenNewMusic = vi.fn();
  render(h(Options, { onOpenNewMusic }));
  act(() => screen.getByRole('button', { name: 'Session and Track options' }).click());

  const row = screen.getByTestId('player-new-music-row');
  expect(row.textContent).toContain('New music');
  expect(row.textContent).toContain('Generating 2 · 22 / 60 min');

  act(() => row.click());

  expect(onOpenNewMusic).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('opens the Lyrics from their tile', () => {
  const onOpenLyrics = vi.fn();
  render(h(Options, { lyricsAvailable: true, onOpenLyrics }));
  act(() => screen.getByRole('button', { name: 'Session and Track options' }).click());

  act(() => screen.getByTestId('player-open-lyrics').click());

  expect(onOpenLyrics).toHaveBeenCalledOnce();
});

it('offers Convert to Playlist with no current Track, as after a reload before play', () => {
  const onConvertToPlaylist = vi.fn();
  render(h(Options, { onConvertToPlaylist }));
  act(() => screen.getByRole('button', { name: 'Session and Track options' }).click());
  act(() => screen.getByTestId('player-convert-session-to-playlist').click());
  expect(onConvertToPlaylist).toHaveBeenCalledOnce();
});

it('keeps Change Vibe unavailable while the player says so', () => {
  render(h(Options, { changeVibeAvailable: false }));
  act(() => screen.getByRole('button', { name: 'Session and Track options' }).click());
  expect((screen.getByTestId('player-options-change-vibe') as HTMLButtonElement).disabled).toBe(
    true,
  );
});
