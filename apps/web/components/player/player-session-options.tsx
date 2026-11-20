'use client';

// The options sheet for a Session source: the shared sheet, wired to what a
// Session can be asked to do. Stopping is not destructive — the Session resumes
// from My Sessions — so it closes the sheet as a neutral action rather than the
// warn red the Deletes carry.

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { Square } from 'lucide-react';
import { MAX_SESSION_TITLE_LENGTH } from '@liedmotif/shared';
import { OfflineMenuRow } from '@/components/offline/offline-menu-row';
import { largeSecondaryButtonClass } from '@/components/ui/form-styles';
import { MenuRow } from '@/components/ui/menu-row';
import { OnlineOnly } from '@/components/ui/online-only';
import { SheetClose } from '@/components/ui/sheet';
import { cn } from '@/lib/cn';
import { sessionDownloadUrl, startFileDownload } from '@/lib/downloads/downloads';
import { NEW_MUSIC_ICONS } from './new-music-icons';
import { newMusicStatusLine, type NewMusicStatus } from './new-music-status';
import { SESSION_OPTIONS_SCOPES, type AvailableSessionOptionsId } from './player-options-model';
import {
  sectionLoopAction,
  sleepTimerAction,
  trackScopeActions,
  type OptionsRowAction,
  type OptionsTrack,
} from './player-options-rows';
import type { SectionLoopControl } from './playback-controller-api';
import { PlayerOptionsSheet } from './player-options-sheet';
import { deleteSessionConfirm } from './player-presentation';

// The cover sheet loads as its own chunk so the player page bundle
// stays free of the crop/upload libraries it pulls in.
const SessionCoverSheet = dynamic(
  () => import('./session-cover-sheet').then((m) => m.SessionCoverSheet),
  { ssr: false },
);

export function PlayerSessionOptions({
  sessionId,
  sessionTitle,
  newMusicStatus,
  onOpenNewMusic,
  coverImageId,
  busy,
  onStop,
  lyricsAvailable,
  onOpenLyrics,
  onOpenTrackData,
  track,
  onRenameSession,
  onRenameTrack,
  onConvertToPlaylist,
  onReroll,
  onMoreLikeThis,
  moreLikeThisAvailable,
  onOpenChangeVibe,
  changeVibeAvailable,
  onDeleteTrack,
  onDeleteSession,
  blendEnabled,
  onToggleBlend,
  onAddTrackToPlaylist,
  sleepTimerEndsAt,
  sectionLoop,
}: {
  sessionId: string;
  sessionTitle: string;
  newMusicStatus: NewMusicStatus;
  /** Opens the New Music sheet (parent-owned, so two sheets never stack). */
  onOpenNewMusic: () => void;
  coverImageId: string | null;
  busy: boolean;
  onStop: () => void;
  /** Whether the current Track is vocal — instrumental greys the Lyrics row. */
  lyricsAvailable: boolean;
  /** Opens the Lyrics sheet (parent-owned, so two sheets never stack). */
  onOpenLyrics: () => void;
  /** Opens the Track Data sheet (parent-owned, like Lyrics). */
  onOpenTrackData: () => void;
  /** The current Track — null disables what needs one. */
  track: OptionsTrack | null;
  /** Perform the rename; resolve to an error message, or null. */
  onRenameSession: (title: string) => Promise<string | null>;
  onRenameTrack: (trackId: string, title: string) => Promise<string | null>;
  /** File the Session's Tracks so far into a new Playlist; the Session plays on. */
  onConvertToPlaylist: () => void;
  /** Dislike the current Track and reroll it in the same vibe. */
  onReroll: () => void;
  /** Start a new Session seeded from the current Track (after the confirm). */
  onMoreLikeThis: () => Promise<void>;
  /** Whether More Like This can start now; the player's button reads the same. */
  moreLikeThisAvailable: boolean;
  /** Opens the Change Vibe sheet (parent-owned, so two sheets never stack). */
  onOpenChangeVibe: () => void;
  /** Whether the Change Vibe sheet can open now; the player's button reads the same. */
  changeVibeAvailable: boolean;
  /** Destroy the Track's audio and carry playback past it (after the confirm). */
  onDeleteTrack: (trackId: string) => Promise<void>;
  /** Stop this Session, then delete it (after the confirm). */
  onDeleteSession: () => Promise<void>;
  /** Whether consecutive Tracks blend at their edges (persisted setting). */
  blendEnabled: boolean;
  /** Flip blended Track transitions live; the sheet stays open. */
  onToggleBlend: () => void;
  /** Opens the playlist picker for the current Track (parent-owned sheet). */
  onAddTrackToPlaylist: () => void;
  /** When the Sleep Timer silences the music (epoch ms), or null while off. */
  sleepTimerEndsAt: number | null;
  /** The Loop a Part tool (parent-owned: the control row drives it too). */
  sectionLoop: SectionLoopControl;
}) {
  const [coverSheetOpen, setCoverSheetOpen] = useState(false);

  const trackActions = trackScopeActions({
    track,
    lyricsAvailable,
    onOpenLyrics,
    onRenameTrack,
    onOpenTrackData,
  });
  const actions: Record<AvailableSessionOptionsId, OptionsRowAction> = {
    ...trackActions,
    // The Lyrics tile keeps the shared test id; the row repeating it takes its own.
    lyrics: { ...trackActions.lyrics, testId: 'player-options-lyrics' },
    'add-to-playlists': track
      ? {
          kind: 'button',
          testId: 'player-options-add-to-playlists',
          onSelect: onAddTrackToPlaylist,
        }
      : { kind: 'unavailable', testId: 'player-options-add-to-playlists' },
    'section-loop': sectionLoopAction(track, sectionLoop),
    'reroll-track': track
      ? { kind: 'button', testId: 'player-options-reroll', onSelect: onReroll }
      : { kind: 'unavailable', testId: 'player-options-reroll' },
    'more-like-this-track':
      track && moreLikeThisAvailable
        ? {
            kind: 'confirm',
            testId: 'player-options-more-like-this',
            heading: 'More Like This',
            body: `Start a new session seeded from “${track.title}”? This session becomes stopped and remains resumable.`,
            confirmLabel: 'Start New Session',
            onConfirm: onMoreLikeThis,
          }
        : { kind: 'unavailable', testId: 'player-options-more-like-this' },
    'delete-track': track
      ? {
          kind: 'confirm',
          testId: 'player-delete-track',
          heading: 'Delete Track',
          body: `Permanently delete “${track.title}”? Its audio is removed from storage and it leaves this session and your Library; this is not feedback and steers nothing.`,
          confirmLabel: 'Delete',
          onConfirm: () => onDeleteTrack(track.trackId),
        }
      : { kind: 'unavailable', testId: 'player-delete-track' },
    'change-vibe': changeVibeAvailable
      ? { kind: 'button', testId: 'player-options-change-vibe', onSelect: onOpenChangeVibe }
      : { kind: 'unavailable', testId: 'player-options-change-vibe' },
    'sleep-timer': sleepTimerAction(sleepTimerEndsAt),
    'rename-session': {
      kind: 'rename',
      testId: 'player-rename-session',
      heading: 'Rename Session',
      currentName: sessionTitle,
      maxLength: MAX_SESSION_TITLE_LENGTH,
      onRename: onRenameSession,
    },
    'session-cover': {
      kind: 'button',
      testId: 'player-options-session-cover',
      onSelect: () => setCoverSheetOpen(true),
    },
    'convert-session-to-playlist': {
      kind: 'button',
      testId: 'player-convert-session-to-playlist',
      onSelect: onConvertToPlaylist,
    },
    'download-session': {
      kind: 'button',
      testId: 'player-download-session',
      onSelect: () => startFileDownload(sessionDownloadUrl(sessionId)),
    },
    'delete-session': {
      kind: 'confirm',
      testId: 'player-delete-session',
      ...deleteSessionConfirm(sessionTitle),
      onConfirm: onDeleteSession,
    },
  };

  return (
    <>
      <SessionCoverSheet
        open={coverSheetOpen}
        onClose={() => setCoverSheetOpen(false)}
        sessionId={sessionId}
        sessionTitle={sessionTitle}
        coverImageId={coverImageId}
      />
      <PlayerOptionsSheet
        sourceKind="Session"
        sourceName={sessionTitle}
        coverImageId={coverImageId}
        trackTitle={track?.title ?? null}
        tiles={{
          lyrics: { disabled: !lyricsAvailable, onSelect: onOpenLyrics },
          blend: { enabled: blendEnabled, onToggle: onToggleBlend },
          sourceCover: {
            label: 'Session Cover',
            hint: 'Upload one or generate it',
            testId: 'player-regenerate-cover',
            onSelect: () => setCoverSheetOpen(true),
          },
          addToPlaylist: { disabled: track === null, onSelect: onAddTrackToPlaylist },
        }}
        scopes={SESSION_OPTIONS_SCOPES}
        actions={actions}
        leadRows={
          <>
            <NewMusicRow status={newMusicStatus} onOpen={onOpenNewMusic} />
            <OfflineMenuRow kind="session" id={sessionId} />
          </>
        }
        footer={<StopSession busy={busy} onStop={onStop} />}
      />
    </>
  );
}

function NewMusicRow({ status, onOpen }: { status: NewMusicStatus; onOpen: () => void }) {
  const Icon = NEW_MUSIC_ICONS[status.icon];
  return (
    <SheetClose asChild>
      <MenuRow
        data-testid="player-new-music-row"
        icon={<Icon aria-hidden />}
        label="New Music"
        description={newMusicStatusLine(status)}
        onlineOnly
        onClick={onOpen}
      />
    </SheetClose>
  );
}

function StopSession({ busy, onStop }: { busy: boolean; onStop: () => void }) {
  return (
    <OnlineOnly>
      <SheetClose asChild>
        <button
          type="button"
          disabled={busy}
          onClick={onStop}
          className={cn(largeSecondaryButtonClass, 'mt-6 w-full')}
        >
          <Square className="h-4 w-4" aria-hidden />
          {busy ? 'Stopping Session…' : 'Stop Session'}
        </button>
      </SheetClose>
    </OnlineOnly>
  );
}
