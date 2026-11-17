'use client';

// Now Playing for a Playlist source: the same transport — progress,
// seek, back/skip, mode switch, retention actions — with NO Session shell: no
// Session status, no generation banner, no Buffer, no Change Vibe, no Dislike.
// Art changes with every Track (no shared cover), transitions are plain
// crossfades, and Skip is plain navigation that records nothing. Curation
// stays available while listening: remove-from-this-playlist, the membership
// picker and the star, with the playlist's ordered list one tap away in the
// transport's queue slot.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PlaylistMemberItem, PlaylistSummaryItem } from '@liedmotif/shared';
import {
  deletePlaylist,
  deleteTrack,
  moreLikeThis,
  removePlaylistTrack,
  renamePlaylist,
  renameTrack,
} from '@/lib/api-client';
import { useClientId } from '@/lib/use-client-id';
import { OfflineMark } from '@/components/offline/offline-mark';
import {
  SaveToPlaylistSheet,
  type SavePickerTrack,
} from '@/components/playlists/save-to-playlist-sheet';
import { nowPlayingDetailsClass, nowPlayingLayoutClass } from '@/components/ui/design-system';
import { CoverArt, CoverFallback } from './cover-art';
import { PlayerCoverSleeve } from './player-cover-sleeve';
import { PlayerHeader } from './player-header';
import { TrackMetaLine } from './track-meta-line';
import { PlayerLyricsSheet } from './player-lyrics-sheet';
import { PlayerMobileHeader } from './player-mobile-header';
import {
  PLAYER_STATUS_LABEL,
  presentTrackGenres,
  resolveCoverImageId,
} from './player-presentation';
import { optionsTrackOf } from './playable-track';
import { PlaylistOptions } from './playlist-options';
import { sectionLoopControl } from './playback-controller-api';
import { usePlayerContext, type LivePlayback } from './player-provider';
import { TrackDataSheet } from './track-data-sheet';
import { SectionLoopBar } from './section-loop-bar';
import { TransportControls } from './transport-controls';
import { PlaylistQueueSheet } from './playlist-queue-sheet';
import { useLyricsSurfaces } from './use-lyrics-surfaces';
import { usePlayerErrorToast } from './use-player-error-toast';

export function PlaylistNowPlaying({
  playback,
  playlist: engagedPlaylist,
}: {
  playback: LivePlayback;
  playlist: PlaylistSummaryItem;
}) {
  const { player } = playback;
  const { engage, engagePlaylist, release, beginOtherMusic, sleepTimer } = usePlayerContext();
  const router = useRouter();
  const clientId = useClientId();
  // The playlist's own editable facts (name, cover) follow the sheet's writes
  // here: the engaged source is a snapshot the controller is keyed on, and
  // re-engaging it to carry a rename would restart playback. This surface is
  // mounted per playlist id, so the engaged summary is the right starting point.
  const [playlist, setPlaylist] = useState(engagedPlaylist);
  const track = player.currentTrack;
  const hasTrack = track != null;
  const statusLabel = PLAYER_STATUS_LABEL[player.status];
  const coverId = resolveCoverImageId(player, null);
  const trackGenres = presentTrackGenres(track?.genreTags ?? []);
  const queueIndex = track ? player.playableQueueItemIds.indexOf(track.queueItemId) : -1;
  const items: PlaylistMemberItem[] =
    playback.source.kind === 'playlist' ? playback.source.items : [];
  // The visitor scope: a foreign In-Lounge playlist plays through
  // this same surface with every owner act absent — never disabled.
  const foreign = playback.source.kind === 'playlist' && playback.source.foreign;
  const originSessionTitle = track?.originSessionTitle ?? 'Untitled Session';

  const [savePickerTrack, setSavePickerTrack] = useState<SavePickerTrack | null>(null);
  // Track Data is parent-owned for the same never-stack reason as Lyrics; it
  // closes when the Track disappears (removal, delete, an empty playlist). The
  // ordered list is parent-owned too, but it is about the Playlist rather than
  // the Track, so it outlives one — jumping into it is the way back to audio.
  const [trackDataSheetOpen, setTrackDataSheetOpen] = useState(false);
  const [queueSheetOpen, setQueueSheetOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const seedingRef = useRef(false);
  const removingRef = useRef(false);
  // A confirm pins its tap-time closures, so the audible Track is read live.
  const currentTrackIdRef = useRef<string | null>(null);
  useEffect(() => {
    currentTrackIdRef.current = track?.trackId ?? null;
  });
  // The player's own writes (the star, the blend toggle) report through it, so a
  // refused one is announced here as well as a refused curation write. Every
  // current failure shows, so an older one never hides a newer one.
  const surfaceError = [player.actionError, actionError].filter(Boolean).join(' ');
  usePlayerErrorToast(surfaceError);
  useEffect(() => {
    if (!hasTrack) {
      setSavePickerTrack(null);
      setTrackDataSheetOpen(false);
    }
  }, [hasTrack]);

  const { lyricsAvailable, lyricsSheetOpen, setLyricsSheetOpen } = useLyricsSurfaces(track);

  /** Open the playlist-membership picker for the current Track; the sheet pins
   *  it, so playback advancing mid-edit never retargets the commit. */
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

  /** Continue playback without `removedTrackId`: re-engage the playlist on the
   * remaining members, starting at the member after the removed one (wrapping),
   * or at the audible Track when playback has already moved past it; nothing
   * left = stop. A hard re-engage keeps the live projection and the ordered
   * list truthful — the removed track can never replay from a loop. */
  function continueWithout(removedTrackId: string) {
    const remaining = items.filter((item) => item.id !== removedTrackId);
    const playable = remaining.filter((item) => item.audioUrl !== null);
    if (playable.length === 0) {
      release();
      router.push(`/library/playlist/${playlist.id}`);
      return;
    }
    const audible = playable.find((item) => item.id === currentTrackIdRef.current);
    if (audible) {
      engagePlaylist(playlist, remaining, audible.id, { foreign });
      return;
    }
    const oldIndex = items.findIndex((item) => item.id === removedTrackId);
    const next =
      remaining.slice(oldIndex === -1 ? 0 : oldIndex).find((item) => item.audioUrl !== null) ??
      playable[0]!;
    engagePlaylist(playlist, remaining, next.id, { foreign });
  }

  /** Remove-from-this-playlist while listening: curation, never feedback. */
  async function removeFromPlaylist(trackId: string) {
    // A repeat tap would re-engage a second time and restart the next Track.
    if (removingRef.current) return;
    removingRef.current = true;
    try {
      setActionError(null);
      const result = await removePlaylistTrack(playlist.id, trackId);
      if (!result.ok) {
        setActionError(`Remove failed — the track stays in the playlist. ${result.error.message}`);
        return;
      }
      router.refresh();
      continueWithout(trackId);
    } finally {
      removingRef.current = false;
    }
  }

  /** Delete Track destroys the audio itself, not a membership: the
   * Track leaves every playlist and the Library with it, and it is not
   * feedback — nothing is steered by it. */
  async function deleteTrackEverywhere(trackId: string) {
    setActionError(null);
    const result = await deleteTrack(trackId);
    if (!result.ok) {
      setActionError(`Delete failed — the track is unchanged. ${result.error.message}`);
      return;
    }
    continueWithout(trackId);
  }

  async function applyRenameTrack(trackId: string, title: string): Promise<string | null> {
    const result = await renameTrack(trackId, title);
    if (!result.ok) return result.error.message;
    // The controller also republishes the lock-screen metadata.
    player.applyTrackTitle(result.data.trackId, result.data.title);
    return null;
  }

  async function applyRenamePlaylist(name: string): Promise<string | null> {
    const result = await renamePlaylist(playlist.id, name);
    if (!result.ok) return result.error.message;
    setPlaylist((current) => ({ ...current, name }));
    return null;
  }

  /** Deleting the source under the player: playback has nothing left to play. */
  async function deleteCurrentPlaylist() {
    setActionError(null);
    const result = await deletePlaylist(playlist.id);
    if (!result.ok) {
      setActionError(`Delete failed — the playlist is unchanged. ${result.error.message}`);
      return;
    }
    release();
    router.push('/library');
  }

  /** More Like This seeds a NEW Session (a Playlist absorbs no generated
   * Tracks); engaging it hands playback over exactly as the Session surface
   * does — audibly through the provider's crossfade while the playlist plays. */
  async function seedMoreLikeThis() {
    // Each request creates a Session that buys its initial fill, and the row
    // shows no progress, so a repeat tap while one is in flight is dropped.
    if (seedingRef.current) return;
    seedingRef.current = true;
    try {
      setActionError(null);
      if (!(await beginOtherMusic())) return;
      const result = await moreLikeThis(
        items.slice(0, 10).map((item) => item.id),
        clientId,
      );
      if (!result.ok) {
        setActionError(`More Like This didn’t start: ${result.error.message}`);
        return;
      }
      engage(result.data.session, { autoplay: false });
    } finally {
      seedingRef.current = false;
    }
  }

  const playlistOptions = (
    <PlaylistOptions
      playlist={playlist}
      visitor={foreign}
      coverImageId={coverId}
      track={optionsTrackOf(track)}
      lyricsAvailable={lyricsAvailable}
      onOpenLyrics={() => setLyricsSheetOpen(true)}
      onOpenTrackData={() => setTrackDataSheetOpen(true)}
      blendEnabled={player.blendEnabled}
      onToggleBlend={player.toggleBlend}
      onAddTrackToPlaylist={openSavePicker}
      onCoverChanged={(coverImageId) => setPlaylist((current) => ({ ...current, coverImageId }))}
      onRenameTrack={applyRenameTrack}
      onRenamePlaylist={applyRenamePlaylist}
      onRemoveTrack={removeFromPlaylist}
      onDeleteTrack={deleteTrackEverywhere}
      onMoreLikeThis={() => void seedMoreLikeThis()}
      moreLikeThisAvailable={items.length > 0}
      onDeletePlaylist={deleteCurrentPlaylist}
      sleepTimerEndsAt={sleepTimer.endsAt}
      sectionLoop={sectionLoopControl(player)}
    />
  );

  return (
    <section
      aria-label="Now playing"
      data-testid="now-playing"
      data-playlist-id={playlist.id}
      data-player-status={player.status}
      data-queue-length={player.queueLength}
      className={nowPlayingLayoutClass}
    >
      <div className="min-w-0">
        <PlayerMobileHeader
          title={foreign ? 'Now Playing from the Lounge' : 'Now Playing your Playlist'}
          action={playlistOptions}
        />
        <PlayerCoverSleeve
          player={player}
          session={null}
          coverImageId={coverId}
          lyricsAvailable={lyricsAvailable}
          onExpandLyrics={() => setLyricsSheetOpen(true)}
        >
          <CoverArt
            coverImageId={coverId}
            eager
            className="h-full w-full object-cover"
            fallback={<CoverFallback />}
          />
        </PlayerCoverSleeve>
      </div>

      <div className={nowPlayingDetailsClass}>
        <PlayerHeader
          statusLabel={`${statusLabel} · Playlist`}
          statusMark={<OfflineMark kind="playlist" id={playlist.id} />}
          title={track?.title ?? playlist.name}
          subtitle={originSessionTitle}
          announcement={
            track
              ? `${statusLabel}: ${track.title ?? 'Untitled Track'} from ${originSessionTitle}.`
              : `${statusLabel}: ${playlist.name}.`
          }
          controls={{ hasTrack, player, onAddToPlaylist: openSavePicker }}
          options={playlistOptions}
        />

        <TrackMetaLine genres={trackGenres} />

        <div className="mt-4">
          <SectionLoopBar
            tool={player.sectionLoopTool}
            onSetLoop={player.setSectionLoop}
            onClearLoop={player.clearSectionLoop}
            track={track}
            trackNumber={queueIndex >= 0 ? queueIndex + 1 : null}
            trackCount={player.trackCount}
            getPlaybackSample={player.getPlaybackSample}
            seekTo={player.seekTo}
            staged={null}
          />
        </div>

        <TransportControls
          player={player}
          sourceNoun="Playlist"
          onOpenQueue={() => setQueueSheetOpen(true)}
        />

        <PlaylistQueueSheet
          open={queueSheetOpen}
          onOpenChange={setQueueSheetOpen}
          playlistName={playlist.name}
          tracks={items}
          currentTrackId={track?.trackId ?? null}
          onPlayTrack={(trackId) => player.playQueueItem(trackId)}
        />

        <PlayerLyricsSheet
          open={lyricsSheetOpen}
          onOpenChange={setLyricsSheetOpen}
          trackId={track?.trackId ?? null}
          getPlaybackSample={player.getPlaybackSample}
          seekTo={player.seekTo}
        />

        <SaveToPlaylistSheet
          track={savePickerTrack}
          onClose={() => setSavePickerTrack(null)}
          onApplied={(data) =>
            player.applyRetentionFlags(data.trackId, data.flags, data.inCuratedPlaylist)
          }
        />

        <TrackDataSheet
          open={trackDataSheetOpen}
          onOpenChange={setTrackDataSheetOpen}
          trackId={track?.trackId ?? null}
        />
      </div>
    </section>
  );
}
