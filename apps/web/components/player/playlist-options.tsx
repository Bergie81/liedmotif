'use client';

// The options sheet for a Playlist source: the shared sheet, wired
// to what a Playlist can be asked to do. Memberships are ticked in the picker
// tile, and the one a listener drops mid-play — this playlist's — has its own
// row; the writes themselves belong to the player surface, which owns the
// playback consequences of a Track or a Playlist going away.

import { useState } from 'react';
import { MAX_PLAYLIST_NAME_LENGTH, type PlaylistSummaryItem } from '@liedmotif/shared';
import { OfflineMenuRow } from '@/components/offline/offline-menu-row';
import { PlaylistCoverSheet } from '@/components/playlists/playlist-cover-sheet';
import { deletePlaylistConfirmBody } from '@/components/playlists/playlist-view-model';
import { playlistDownloadUrl, startFileDownload } from '@/lib/downloads';
import {
  playlistOptionsScopes,
  visitorPlaylistOptionsScopes,
  type AvailablePlaylistOptionsId,
} from './player-options-model';
import {
  sectionLoopAction,
  sleepTimerAction,
  trackScopeActions,
  type OptionsRowAction,
  type OptionsTrack,
} from './player-options-rows';
import type { SectionLoopControl } from './playback-controller-api';
import { PlayerOptionsSheet } from './player-options-sheet';

export function PlaylistOptions({
  playlist,
  visitor = false,
  coverImageId,
  track,
  lyricsAvailable,
  onOpenLyrics,
  onOpenTrackData,
  blendEnabled,
  onToggleBlend,
  onAddTrackToPlaylist,
  onCoverChanged,
  onRenameTrack,
  onRenamePlaylist,
  onRemoveTrack,
  onDeleteTrack,
  onMoreLikeThis,
  moreLikeThisAvailable,
  onDeletePlaylist,
  sleepTimerEndsAt,
  sectionLoop,
}: {
  playlist: PlaylistSummaryItem;
  /** Another owner's In-Lounge playlist: the sheet renders the
   *  visitor scope — owner rows absent, the way back leads to the Lounge view,
   *  and the cover is the owner's to manage, not the listener's. */
  visitor?: boolean;
  /** The current Track's art — the plate's thumb. */
  coverImageId: string | null;
  /** The current Track — null disables what needs one. */
  track: OptionsTrack | null;
  /** Whether the current Track is vocal — instrumental greys the Lyrics row. */
  lyricsAvailable: boolean;
  /** Opens the Lyrics sheet (parent-owned, so two sheets never stack). */
  onOpenLyrics: () => void;
  /** Opens the Track Data sheet (parent-owned, like Lyrics). */
  onOpenTrackData: () => void;
  /** Whether consecutive Tracks blend at their edges (persisted setting). */
  blendEnabled: boolean;
  /** Flip blended Track transitions live; the sheet stays open. */
  onToggleBlend: () => void;
  /** Opens the membership picker for the current Track (parent-owned sheet). */
  onAddTrackToPlaylist: () => void;
  /** The playlist's custom-cover pointer changed (null = back to the mosaic). */
  onCoverChanged: (coverImageId: string | null) => void;
  /** Perform the rename; resolve to an error message, or null. */
  onRenameTrack: (trackId: string, title: string) => Promise<string | null>;
  onRenamePlaylist: (name: string) => Promise<string | null>;
  /** Drop the Track's membership here and carry playback past it — curation,
   *  never feedback: the audio survives wherever else it is saved. */
  onRemoveTrack: (trackId: string) => Promise<void>;
  /** Destroy the Track's audio and carry playback past it. */
  onDeleteTrack: (trackId: string) => Promise<void>;
  /** Seed a NEW Session from this playlist — a Playlist absorbs no generated Tracks. */
  onMoreLikeThis: () => void;
  moreLikeThisAvailable: boolean;
  /** Delete the playlist and leave it (its sole members leave the Library). */
  onDeletePlaylist: () => Promise<void>;
  /** When the Sleep Timer silences the music (epoch ms), or null while off. */
  sleepTimerEndsAt: number | null;
  /** The Loop a Part tool (parent-owned: the control row drives it too). */
  sectionLoop: SectionLoopControl;
}) {
  const [managingCover, setManagingCover] = useState(false);

  const actions: Record<AvailablePlaylistOptionsId, OptionsRowAction> = {
    ...trackScopeActions({ track, lyricsAvailable, onOpenLyrics, onRenameTrack, onOpenTrackData }),
    'section-loop': sectionLoopAction(track, sectionLoop),
    'remove-from-playlist': track
      ? {
          kind: 'button',
          testId: 'player-remove-from-playlist',
          onSelect: () => void onRemoveTrack(track.trackId),
        }
      : { kind: 'unavailable', testId: 'player-remove-from-playlist' },
    'delete-track': track
      ? {
          kind: 'confirm',
          testId: 'playlist-delete-track',
          heading: 'Delete Track',
          body: `Permanently delete “${track.title}”? Its audio is removed from storage; this is not feedback and does not steer anything.`,
          confirmLabel: 'Delete',
          onConfirm: () => onDeleteTrack(track.trackId),
        }
      : { kind: 'unavailable', testId: 'playlist-delete-track' },
    'go-to-playlist': {
      kind: 'link',
      href: visitor ? `/lounge/playlist/${playlist.id}` : `/library/playlist/${playlist.id}`,
    },
    'sleep-timer': sleepTimerAction(sleepTimerEndsAt),
    'rename-playlist': {
      kind: 'rename',
      heading: 'Rename Playlist',
      currentName: playlist.name,
      maxLength: MAX_PLAYLIST_NAME_LENGTH,
      onRename: onRenamePlaylist,
    },
    'download-playlist': {
      kind: 'button',
      testId: 'player-download-playlist',
      onSelect: () => startFileDownload(playlistDownloadUrl(playlist.id)),
    },
    'more-like-this': moreLikeThisAvailable
      ? { kind: 'button', testId: 'playlist-more-like-this', onSelect: onMoreLikeThis }
      : { kind: 'unavailable', testId: 'playlist-more-like-this' },
    'delete-playlist': {
      kind: 'confirm',
      testId: 'playlist-delete',
      heading: 'Delete Playlist',
      body: deletePlaylistConfirmBody(playlist),
      confirmLabel: 'Delete',
      onConfirm: onDeletePlaylist,
    },
  };

  return (
    <>
      <PlaylistCoverSheet
        playlist={playlist}
        open={managingCover}
        onClose={() => setManagingCover(false)}
        onCoverChanged={onCoverChanged}
      />
      <PlayerOptionsSheet
        sourceKind="Playlist"
        sourceName={playlist.name}
        coverImageId={coverImageId}
        trackTitle={track?.title ?? null}
        tiles={{
          blend: { enabled: blendEnabled, onToggle: onToggleBlend },
          sourceCover: {
            label: 'Playlist Cover',
            hint: visitor ? 'The owner manages this cover' : 'Upload one or generate it',
            testId: 'playlist-cover',
            disabled: visitor,
            onSelect: () => setManagingCover(true),
          },
          // Saving stays live for a visitor: it files a Shared
          // reference into the LISTENER's own playlists, never the owner's.
          addToPlaylist: { disabled: track === null, onSelect: onAddTrackToPlaylist },
        }}
        leadRows={<OfflineMenuRow kind="playlist" id={playlist.id} />}
        scopes={visitor ? visitorPlaylistOptionsScopes() : playlistOptionsScopes(playlist.kind)}
        actions={actions}
      />
    </>
  );
}
