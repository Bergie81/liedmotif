'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  isDurationTargetReached,
  isSessionRepeatGenerationStatus,
  type SessionSummary,
} from '@liedmotif/shared';
import { SessionTracksDialog } from '@/components/sessions/session-tracks-sheet';
import {
  deleteSession,
  deleteTrack,
  renameSession,
  renameTrack,
  stopSession,
} from '@/lib/api-client';
import { nowPlayingDetailsClass, nowPlayingLayoutClass } from '@/components/ui/design-system';
import { OnlineOnly } from '@/components/ui/online-only';
import { cn } from '@/lib/cn';
import { coldStartStagedCopy } from './cold-start-progress';
import { CoverFallback } from './cover-art';
import { HeroCoverArt } from './hero-cover-art';
import { CoverChip } from './cover-chip';
import { DeleteSessionAction, GenerationBanner } from './generation-banner';
import { PlayerCoverSleeve } from './player-cover-sleeve';
import { PlayerDirectionActions } from './player-direction-actions';
import { PlayerLyricsSheet } from './player-lyrics-sheet';
import { PlayerMobileHeader } from './player-mobile-header';
import { PlayerHeader } from './player-header';
import { PlayerSessionOptions } from './player-session-options';
import {
  countGeneratingAhead,
  SESSION_PLAYER_STATUS_LABEL,
  presentIncomingSession,
  presentSessionActivity,
  presentSource,
  presentTrackGenres,
  resolveCoverImageId,
  type IncomingSession,
} from './player-presentation';
import { optionsTrackOf } from './playable-track';
import { sectionLoopControl, sectionLoopLive } from './playback-controller-api';
import { usePlayerContext, type LivePlayback } from './player-provider';
import { NewMusicSheet } from './new-music-sheet';
import { presentNewMusicStatus } from './new-music-status';
import { NewMusicStatusButton } from './new-music-status-button';
import {
  SaveToPlaylistSheet,
  type SavePickerTrack,
} from '@/components/playlists/save-to-playlist-sheet';
import { TrackDataSheet } from './track-data-sheet';
import { TrackMetaLine } from './track-meta-line';
import { SectionLoopBar } from './section-loop-bar';
import { OfflineMark } from '@/components/offline/offline-mark';
import { TransportControls } from './transport-controls';
import { useLyricsSurfaces } from './use-lyrics-surfaces';
import { clearPlayerError, showPlayerError } from './player-error-toast';
import { usePlayerSessionActions } from './use-player-session-actions';
import {
  presentVibeChangeCaption,
  presentVibeChangePending,
  presentVibeSwitch,
} from './vibe-switch-view';

/** How long the cover's source badge stays up after a source commits — a
 * transient announcement, never a permanent overlay on the art. */
const SOURCE_BADGE_MS = 4000;

/** The status line's vocals readout — null on an instrumental Track. The
 * vibe's language belongs to the LIVE revision; a track generated under an
 * earlier Change Vibe may sing another language, so it reads plain "Vocals"
 * there. */
function presentVocals(input: {
  isVocal: boolean;
  language: string | null;
  trackStyleRevision: number | null;
  sessionStyleRevision: number | null;
}): string | null {
  if (!input.isVocal) return null;
  if (input.language && input.trackStyleRevision === input.sessionStyleRevision) {
    return `${input.language} vocals`;
  }
  return 'Vocals';
}

interface StatusChip {
  chip: string;
  detail: string;
  testId: string;
}

/** The one persistent status announcement the cover art carries, and the
 * precedence between the three that can want it: an incoming Session outranks
 * the armed vibe switch, which outranks the still-in-flight Change Vibe. */
function presentStatusChip(input: {
  incoming: IncomingSession | null;
  switchPending: boolean;
  vibeChangePending: boolean;
}): StatusChip | null {
  const incoming = input.incoming ? presentIncomingSession(input.incoming) : null;
  if (incoming) return { ...incoming, testId: 'incoming-session-chip' };
  const vibeSwitch = presentVibeSwitch(input.switchPending);
  if (vibeSwitch) return { ...vibeSwitch, testId: 'vibe-switch-chip' };
  const vibeChange = presentVibeChangePending(input.vibeChangePending);
  if (vibeChange) return { ...vibeChange, testId: 'vibe-pending-chip' };
  return null;
}

/** The status announcement itself: the visible caption, with the detail as its
 * hover title and screen-reader tail. */
function StatusCoverChip({ chip }: { chip: StatusChip }) {
  return (
    <CoverChip
      tone="lamp"
      role="status"
      aria-live="polite"
      data-testid={chip.testId}
      title={`${chip.chip} ${chip.detail}`}
    >
      {chip.chip}
      <span className="sr-only"> {chip.detail}</span>
    </CoverChip>
  );
}

export function NowPlaying({
  playback,
  session,
  incoming = null,
  onSessionChange,
  onStopped,
}: {
  playback: LivePlayback;
  /** The engaged Session (the caller renders this surface only for a Session
   * source — a Playlist plays through PlaylistNowPlaying, without the shell). */
  session: SessionSummary;
  /** A Session on its way to replace this one (the dual-host handoff): the
   * cover chip and slider status narrate it while this playback continues. */
  incoming?: IncomingSession | null;
  onSessionChange: (session: SessionSummary) => void;
  onStopped: () => void;
}) {
  const { player, coldStartBeganAt } = playback;
  // Async actions settle after later renders: they read the live player here,
  // never the snapshot their closure was created with.
  const playerRef = useRef(player);
  const router = useRouter();
  playerRef.current = player;
  // Target edits return the policy immediately; queue polls supply live accounting.
  // The New music policy follows whichever moved last: this player's own edit
  // (the summary) or a poll reporting a change made on another device.
  const [newMusicPolicy, setNewMusicPolicy] = useState(() => ({
    sessionMode: session.sessionMode,
    targetDurationMinutes: session.targetDurationMinutes ?? null,
  }));
  useEffect(() => {
    setNewMusicPolicy({
      sessionMode: session.sessionMode,
      targetDurationMinutes: session.targetDurationMinutes ?? null,
    });
  }, [session.sessionMode, session.targetDurationMinutes]);
  const polledSessionMode = player.sessionMode;
  const polledTargetDurationMinutes = player.targetDurationMinutes ?? null;
  useEffect(() => {
    if (polledSessionMode === undefined) return;
    setNewMusicPolicy({
      sessionMode: polledSessionMode,
      targetDurationMinutes: polledTargetDurationMinutes,
    });
  }, [polledSessionMode, polledTargetDurationMinutes]);
  const durationSession = {
    ...session,
    ...newMusicPolicy,
    generatedDurationSeconds: player.generatedDurationSeconds ?? session.generatedDurationSeconds,
    unknownDurationTrackCount:
      player.unknownDurationTrackCount ?? session.unknownDurationTrackCount,
  };
  const track = player.currentTrack;
  const coverId = resolveCoverImageId(player, session);
  const staged = coldStartStagedCopy({
    status: player.status,
    queueLength: player.queueLength,
    generationStatus: player.generationStatus,
    statusMessageSafe: player.statusMessageSafe,
    pendingGeneration: player.pendingGeneration,
    coldStartBeganAt,
  });
  const hasTrack = track != null;
  const statusLabel = SESSION_PLAYER_STATUS_LABEL[player.status];
  const source = presentSource(player.sourceKind);
  const trackGenres = presentTrackGenres(track?.genreTags ?? []);
  const [showSourceBadge, setShowSourceBadge] = useState(false);
  const sourceKind = player.sourceKind;
  const currentQueueItemId = track?.queueItemId ?? null;
  useEffect(() => {
    if (!sourceKind) {
      setShowSourceBadge(false);
      return;
    }
    setShowSourceBadge(true);
    const id = setTimeout(() => setShowSourceBadge(false), SOURCE_BADGE_MS);
    return () => clearTimeout(id);
  }, [sourceKind, currentQueueItemId]);
  // Change Vibe runs at provider scope (fire-and-forget), so its pending/error
  // narration survives navigating away and back mid-request.
  const { vibeChange, submitChangeVibe, pending: pendingSource, sleepTimer } = usePlayerContext();
  const vibeChangePending = vibeChange.pendingSessionId === session.id;
  const statusChip = presentStatusChip({
    incoming,
    switchPending: player.switchPending,
    vibeChangePending,
  });
  const sessionRepeat =
    durationSession.sessionMode === 'repeat' ||
    isSessionRepeatGenerationStatus(player.generationStatus) ||
    isDurationTargetReached(
      durationSession.targetDurationMinutes,
      durationSession.generatedDurationSeconds,
    );
  const sessionTitle = session.title ?? 'Untitled Session';
  const sessionActions = usePlayerSessionActions({
    sessionId: session.id,
    trackId: track?.trackId ?? null,
    onSessionChange,
    onStopped,
    onConverted: (playlistId) => {
      // Library would otherwise replay its pre-convert list from the router cache.
      router.refresh();
      router.push(`/library/playlist/${playlistId}`);
    },
  });
  const generatingAhead = countGeneratingAhead({
    items: player.queueItems,
    currentQueueItemId,
    generatingTracksAhead: player.generatingTracksAhead,
  });
  const newMusicStatus = presentNewMusicStatus({
    session: durationSession,
    generatingAhead,
    generationStatus: player.generationStatus,
    loopHeld: player.loopHeld,
  });
  const sessionActivity = presentSessionActivity({
    incoming: incoming != null,
    vibeChangeCaption: presentVibeChangeCaption({
      items: player.queueItems,
      currentTrackStyleRevision: track?.styleRevision ?? null,
      sessionStyleRevision: player.styleRevision,
      generatingNewVibeTracksAhead: player.generatingNewVibeTracksAhead,
      requestPending: vibeChangePending,
    }),
    sessionRepeat,
    generatingAhead,
  });
  // The Change Vibe sheet's open state lives here so the options menu and the
  // direction bar open the same sheet.
  const [changeVibeOpen, setChangeVibeOpen] = useState(false);
  // Change Vibe steers the Session, so no current Track is needed. The sheet
  // preselects the vibe from the first queue poll and builds its request against
  // it, so it waits for that, and for any other action in flight.
  const changeVibeAvailable =
    player.styleRevision != null && !vibeChangePending && sessionActions.busyAction === null;
  const [deletingSession, setDeletingSession] = useState(false);
  // The policy is only this player's to write while the Session it is showing
  // is the live, settled one: a stop, a delete, or a handoff to another Session
  // is about to take the Session the owner would be aiming at. A pending Change
  // Vibe may write its own target over a change made here meanwhile.
  const newMusicAvailable =
    session.status === 'active' &&
    player.sessionStatus === 'active' &&
    sessionActions.busyAction === null &&
    !vibeChangePending &&
    !deletingSession &&
    !incoming &&
    !pendingSource;
  // Parent-owned for the same never-stack reason as Lyrics: the options menu
  // and the header open this one sheet.
  const [newMusicOpen, setNewMusicOpen] = useState(false);

  const { lyricsAvailable, lyricsSheetOpen, setLyricsSheetOpen } = useLyricsSurfaces(track);
  // Track Data is parent-owned for the same never-stack reason as Lyrics; it
  // closes when the Track disappears (session handoff, stop). The Session's
  // Tracks sheet is parent-owned too, but it is about the Session rather than
  // the Track, so it outlives one.
  const [trackDataSheetOpen, setTrackDataSheetOpen] = useState(false);
  const [queueSheetOpen, setQueueSheetOpen] = useState(false);
  useEffect(() => {
    if (!hasTrack) setTrackDataSheetOpen(false);
  }, [hasTrack]);
  // The Save button opens the playlist picker (retention is membership): the
  // sheet pins the track it was opened for, so playback advancing mid-edit
  // never retargets the commit.
  const [savePickerTrack, setSavePickerTrack] = useState<SavePickerTrack | null>(null);
  useEffect(() => {
    if (!hasTrack) setSavePickerTrack(null);
  }, [hasTrack]);
  function openSavePicker() {
    if (track) {
      setSavePickerTrack({
        id: track.trackId,
        title: track.title,
        savedAt: track.savedAt,
        coverImageId: coverId,
      });
    }
  }
  const vocalsLabel = presentVocals({
    isVocal: track?.vocalMode === 'vocal',
    language: player.vibe?.language ?? null,
    trackStyleRevision: track?.styleRevision ?? null,
    sessionStyleRevision: player.styleRevision,
  });

  // The live name follows the server's accepted summary; a refused Rename
  // leaves the name unchanged and returns its reason to the dialog.
  async function applyRenameSession(title: string): Promise<string | null> {
    const result = await renameSession(session.id, title);
    if (!result.ok) return result.error.message;
    onSessionChange(result.data.session);
    router.refresh();
    return null;
  }
  // The track title goes to the controller instead — it also republishes the
  // lock-screen metadata.
  async function applyRenameTrack(trackId: string, title: string): Promise<string | null> {
    const result = await renameTrack(trackId, title);
    if (!result.ok) return result.error.message;
    player.applyTrackTitle(result.data.trackId, result.data.title);
    return null;
  }

  /** Delete Track destroys the audio itself — not feedback, nothing
   * is steered, so it never advances through Skip. The action was pinned at
   * tap time, so playback may have moved on while the confirm was up: the
   * controller advances only when the deleted Track is still the audible one,
   * then the authoritative Queue confirms. */
  async function deleteCurrentTrack(trackId: string): Promise<void> {
    clearPlayerError(session.id, 'delete-track');
    const result = await deleteTrack(trackId);
    if (!result.ok) {
      showPlayerError(
        session.id,
        'delete-track',
        `Delete failed — the track is unchanged. ${result.error.message}`,
      );
      return;
    }
    const live = playerRef.current;
    live.advancePastDeletedTrack(trackId);
    live.refreshQueue();
  }

  /** Delete Session from the player: the server refuses to delete an ACTIVE
   * session, so this stops it first — the same two states My Sessions' delete
   * moves through, collapsed into one confirmed action. */
  async function deleteCurrentSession(): Promise<void> {
    clearPlayerError(session.id, 'delete-session');
    setDeletingSession(true);
    try {
      const stopped = await stopSession(session.id);
      if (!stopped.ok) {
        showPlayerError(
          session.id,
          'delete-session',
          `Delete failed — the Session is unchanged. ${stopped.error.message}`,
        );
        return;
      }
      const result = await deleteSession(session.id);
      if (!result.ok) {
        showPlayerError(
          session.id,
          'delete-session',
          `The Session is stopped but not deleted: ${result.error.message} It remains in Sessions.`,
        );
        return;
      }
      router.refresh();
      onStopped();
    } finally {
      setDeletingSession(false);
    }
  }

  const sessionOptions = (
    <PlayerSessionOptions
      sessionId={session.id}
      sessionTitle={sessionTitle}
      newMusicStatus={newMusicStatus}
      onOpenNewMusic={() => setNewMusicOpen(true)}
      coverImageId={coverId}
      busy={sessionActions.busyAction === 'stop'}
      onStop={() => void sessionActions.stop()}
      lyricsAvailable={lyricsAvailable}
      onOpenLyrics={() => setLyricsSheetOpen(true)}
      onOpenTrackData={() => setTrackDataSheetOpen(true)}
      track={optionsTrackOf(track)}
      onRenameSession={applyRenameSession}
      onRenameTrack={applyRenameTrack}
      onConvertToPlaylist={() => void sessionActions.convertToPlaylist()}
      onReroll={player.dislike}
      onMoreLikeThis={async () => {
        await sessionActions.startMoreLikeThis();
      }}
      moreLikeThisAvailable={sessionActions.busyAction === null && !vibeChangePending}
      onOpenChangeVibe={() => setChangeVibeOpen(true)}
      changeVibeAvailable={changeVibeAvailable}
      onDeleteTrack={deleteCurrentTrack}
      onDeleteSession={deleteCurrentSession}
      blendEnabled={player.blendEnabled}
      onToggleBlend={player.toggleBlend}
      onAddTrackToPlaylist={openSavePicker}
      sleepTimerEndsAt={sleepTimer.endsAt}
      sectionLoop={sectionLoopControl(player)}
    />
  );

  return (
    <section
      aria-label="Now playing"
      data-testid="now-playing"
      data-session-id={session.id}
      data-player-status={player.status}
      data-queue-length={player.queueLength}
      data-source-kind={player.sourceKind ?? undefined}
      data-edge-tier={player.activeEdgeTier ?? undefined}
      className={nowPlayingLayoutClass}
    >
      <div className="min-w-0">
        <PlayerMobileHeader title="Now Playing your Session" action={sessionOptions} />

        <GenerationBanner
          player={player}
          action={
            <DeleteSessionAction sessionTitle={sessionTitle} onDelete={deleteCurrentSession} />
          }
        />

        <PlayerCoverSleeve
          player={player}
          session={session}
          coverImageId={coverId}
          lyricsAvailable={lyricsAvailable}
          onExpandLyrics={() => setLyricsSheetOpen(true)}
        >
          <HeroCoverArt coverImageId={coverId} fallback={<CoverFallback />} />
          {/* The chip stack: the persistent status chip holds the top slot so
              the transient badges never displace it. */}
          <div className="absolute left-3 top-3 z-[1] flex flex-col items-start gap-2">
            {statusChip ? <StatusCoverChip chip={statusChip} /> : null}
            {source ? (
              <CoverChip
                tone="signal"
                dotClassName="shadow-[0_0_8px_var(--lamp)]"
                className={cn(
                  'transition-opacity duration-500',
                  !showSourceBadge && 'pointer-events-none opacity-0',
                )}
              >
                {source.label} · {source.detail}
              </CoverChip>
            ) : staged ? (
              <CoverChip>{staged.copy}</CoverChip>
            ) : null}
          </div>
        </PlayerCoverSleeve>
      </div>

      <div className={nowPlayingDetailsClass}>
        <PlayerHeader
          statusLabel={statusLabel}
          statusMark={<OfflineMark kind="session" id={session.id} />}
          title={track?.title ?? player.pendingGeneration?.trackTitle ?? sessionTitle}
          subtitle={track?.artist ?? sessionTitle}
          announcement={
            track
              ? `${statusLabel}: ${track.title ?? 'Untitled Track'}${track.artist ? ` by ${track.artist}` : ''}.`
              : `${statusLabel}: ${player.pendingGeneration?.trackTitle ?? sessionTitle}.`
          }
          controls={{ hasTrack, player, onAddToPlaylist: openSavePicker }}
          newMusic={
            <OnlineOnly>
              <NewMusicStatusButton
                status={newMusicStatus}
                generatingAhead={generatingAhead}
                playableTracks={player.playableQueueItemIds}
                onOpen={() => setNewMusicOpen(true)}
              />
            </OnlineOnly>
          }
          options={sessionOptions}
        />

        <TrackMetaLine genres={trackGenres} vocals={vocalsLabel} />

        <div className="mt-4">
          <SectionLoopBar
            tool={player.sectionLoopTool}
            onSetLoop={player.setSectionLoop}
            onClearLoop={player.clearSectionLoop}
            track={track}
            trackNumber={player.currentTrackNumber}
            trackCount={player.trackCount}
            getPlaybackSample={player.getPlaybackSample}
            seekTo={player.seekTo}
            staged={staged}
            activity={sessionActivity}
            newestQueueItemId={player.playableQueueItemIds.at(-1) ?? null}
          />
        </div>

        <TransportControls
          player={player}
          sourceNoun="Session"
          onOpenQueue={() => setQueueSheetOpen(true)}
        />

        <PlayerDirectionActions
          trackTitle={track?.title ?? null}
          vibe={player.vibe}
          targetDurationMinutes={durationSession.targetDurationMinutes}
          generatedDurationSeconds={durationSession.generatedDurationSeconds ?? 0}
          switchNowLocked={player.loopActive || sectionLoopLive(player.sectionLoopTool)}
          disabled={!hasTrack}
          changeVibeAvailable={changeVibeAvailable}
          busyAction={sessionActions.busyAction}
          changeVibePending={vibeChangePending}
          changeVibeOpen={changeVibeOpen}
          onChangeVibeOpenChange={setChangeVibeOpen}
          onReroll={player.dislike}
          onChangeVibe={(input, options) => submitChangeVibe(session.id, input, options)}
          onMoreLikeThis={sessionActions.startMoreLikeThis}
        />

        <NewMusicSheet
          session={durationSession}
          status={newMusicStatus}
          open={newMusicOpen}
          onOpenChange={setNewMusicOpen}
          available={newMusicAvailable}
          onSessionChange={onSessionChange}
        />

        <SessionTracksDialog
          open={queueSheetOpen}
          onOpenChange={setQueueSheetOpen}
          session={{
            id: session.id,
            title: session.title,
            coverImageId: coverId,
            genreTags: [],
          }}
        />

        <PlayerLyricsSheet
          open={lyricsSheetOpen}
          onOpenChange={setLyricsSheetOpen}
          trackId={track?.trackId ?? null}
          getPlaybackSample={player.getPlaybackSample}
          seekTo={player.seekTo}
        />

        <TrackDataSheet
          open={trackDataSheetOpen}
          onOpenChange={setTrackDataSheetOpen}
          trackId={track?.trackId ?? null}
        />
        <SaveToPlaylistSheet
          track={savePickerTrack}
          onClose={() => setSavePickerTrack(null)}
          onApplied={(data) =>
            player.applyRetentionFlags(data.trackId, data.flags, data.inCuratedPlaylist)
          }
        />
      </div>
    </section>
  );
}
