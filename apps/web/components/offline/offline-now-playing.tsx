'use client';

// Now Playing in the Offline Library: the Playlist player's surface with only
// what plays from the device — cover and lyrics sleeve, progress and seek, the
// transport and its ordered list, Lyrics, Track Data and the Sleep Timer.
// Nothing that writes to the server is here at all, not even disabled: no
// blend toggle, no retention, no curation, no generating.

import { useEffect, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import {
  AlertBanner,
  iconButtonClass,
  nowPlayingDetailsClass,
  nowPlayingLayoutClass,
} from '@/components/ui/design-system';
import { cn } from '@/lib/cn';
import { CoverArt, CoverFallback } from '@/components/player/cover-art';
import { PlayerCoverSleeve } from '@/components/player/player-cover-sleeve';
import { TrackMetaLine } from '@/components/player/track-meta-line';
import { PlayerHeader } from '@/components/player/player-header';
import { PlayerLyricsSheet } from '@/components/player/player-lyrics-sheet';
import { offlineOptionsScopes } from '@/components/player/player-options-model';
import { sleepTimerAction, trackScopeActions } from '@/components/player/player-options-rows';
import { PlayerOptionsSheet } from '@/components/player/player-options-sheet';
import {
  PLAYER_STATUS_LABEL,
  presentTrackGenres,
  resolveCoverImageId,
  type SourceNoun,
} from '@/components/player/player-presentation';
import { optionsTrackOf } from '@/components/player/playable-track';
import { usePlayerContext, type LivePlayback } from '@/components/player/player-provider';
import { PlaylistQueueSheet } from '@/components/player/playlist-queue-sheet';
import { TrackDataSheet } from '@/components/player/track-data-sheet';
import { TrackProgress } from '@/components/player/track-progress';
import { TransportControls } from '@/components/player/transport-controls';
import { useLyricsSurfaces } from '@/components/player/use-lyrics-surfaces';

export function OfflineNowPlaying({
  playback,
  name,
  noun,
  onBack,
}: {
  playback: LivePlayback;
  name: string;
  /** What the offline collection is: a Session plays as a fixed list here too. */
  noun: SourceNoun;
  /** Back to the Offline Library's list; the music keeps playing. */
  onBack: () => void;
}) {
  const { player } = playback;
  const { sleepTimer } = usePlayerContext();
  const track = player.currentTrack;
  const statusLabel = PLAYER_STATUS_LABEL[player.status];
  const coverId = resolveCoverImageId(player, null);
  const trackGenres = presentTrackGenres(track?.genreTags ?? []);
  const queueIndex = track ? player.playableQueueItemIds.indexOf(track.queueItemId) : -1;
  const originSessionTitle = track?.originSessionTitle ?? 'Untitled Session';
  const tracks = playback.source.kind === 'offline' ? playback.source.tracks : [];
  // Judged at every render, which every Track change brings.
  const expired = playback.source.kind === 'offline' ? playback.source.expired : () => false;
  const restExpired =
    tracks.some((entry) => expired(entry.trackId)) &&
    tracks.every((entry) => entry.trackId === track?.trackId || expired(entry.trackId));

  const [trackDataSheetOpen, setTrackDataSheetOpen] = useState(false);
  const [queueSheetOpen, setQueueSheetOpen] = useState(false);
  useEffect(() => {
    if (!track) setTrackDataSheetOpen(false);
  }, [track]);
  const { lyricsAvailable, lyricsSheetOpen, setLyricsSheetOpen } = useLyricsSurfaces(track);

  const options = (
    <PlayerOptionsSheet
      sourceKind={noun}
      sourceName={name}
      coverImageId={coverId}
      trackTitle={track?.title ?? null}
      scopes={offlineOptionsScopes(noun)}
      actions={{
        ...trackScopeActions({
          track: optionsTrackOf(track),
          lyricsAvailable,
          onOpenLyrics: () => setLyricsSheetOpen(true),
          // The offline scopes have no Rename row.
          onRenameTrack: async () => null,
          onOpenTrackData: () => setTrackDataSheetOpen(true),
        }),
        'sleep-timer': sleepTimerAction(sleepTimer.endsAt),
      }}
    />
  );

  return (
    <section
      aria-label="Now playing"
      data-testid="now-playing"
      data-player-status={player.status}
      className={nowPlayingLayoutClass}
    >
      <div className="min-w-0">
        <div className="mb-4 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onBack}
            className={cn(iconButtonClass, 'w-auto gap-1 px-2 text-[13.5px] font-semibold')}
          >
            <ChevronLeft className="h-5 w-5" aria-hidden />
            Offline Library
          </button>
          <span className="desk:hidden">{options}</span>
        </div>
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
          statusLabel={`${statusLabel} · Offline`}
          title={track?.title ?? name}
          subtitle={originSessionTitle}
          announcement={
            track
              ? `${statusLabel}: ${track.title ?? 'Untitled Track'} from ${originSessionTitle}.`
              : `${statusLabel}: ${name}.`
          }
          options={options}
        />

        <TrackMetaLine genres={trackGenres} />

        <div className="mt-4">
          <TrackProgress
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
          sourceNoun={noun}
          onOpenQueue={() => setQueueSheetOpen(true)}
        />

        {restExpired ? (
          <AlertBanner className="mt-4">
            The rest of this {noun} expired on this device. Connect to refresh it.
          </AlertBanner>
        ) : null}

        <PlaylistQueueSheet
          open={queueSheetOpen}
          onOpenChange={setQueueSheetOpen}
          playlistName={name}
          tracks={tracks.map((entry) => ({
            id: entry.trackId,
            title: entry.title,
            coverImageId: entry.coverImageId,
            durationSeconds: entry.durationSeconds,
            audioUrl: entry.assets.final,
            expired: expired(entry.trackId),
          }))}
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

        <TrackDataSheet
          open={trackDataSheetOpen}
          onOpenChange={setTrackDataSheetOpen}
          trackId={track?.trackId ?? null}
        />
      </div>
    </section>
  );
}
