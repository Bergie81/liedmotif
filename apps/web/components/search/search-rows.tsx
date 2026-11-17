'use client';

// Result rows act exactly like their home surfaces (reuse, never
// reimplement): Tracks are the Library's rows — preview through a plain
// <audio> outside the transport, the same options sheet and save picker;
// Sessions are My Sessions cards, opening their Tracks; Playlists are the
// Library's playlist rendering, linking into the playlist. Each row adds the
// one match-context line naming why it answered the query.

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Pin } from 'lucide-react';
import type {
  LoungePlaylistOwner,
  SearchPlaylistItem,
  SearchSessionItem,
  SearchTrackItem,
  TrackFlags,
} from '@liedmotif/shared';
import { AvatarBadge } from '@/components/avatar-badge';
import { toast } from '@/lib/toast';
import { Sheet } from '@/components/ui/sheet';
import {
  formatLibraryTrackMetadata,
  getTrackAvailability,
  withSettledRetention,
} from '@/components/library/library-view-model';
import { TrackOptionsSheet } from '@/components/library/track-options-sheet';
import { TrackRow, type TrackRowBadge } from '@/components/library/track-row';
import { useLibraryActions } from '@/components/library/use-library-actions';
import { useTrackRowPlayback } from '@/components/library/use-track-row-playback';
import { loungeOwnerDisplayName } from '@/components/lounge/lounge-view-model';
import { OfflineMark } from '@/components/offline/offline-mark';
import { PlaylistCover } from '@/components/playlists/playlist-cover';
import { formatPlaylistTrackCount } from '@/components/playlists/playlist-view-model';
import {
  SaveToPlaylistSheet,
  type SavePickerTrack,
} from '@/components/playlists/save-to-playlist-sheet';
import { SessionCard } from '@/components/sessions/session-card';
import { SessionTracksProvider } from '@/components/sessions/session-tracks-sheet';
import { MatchContextLine } from './match-context';

/** Called when the user acts on a result — engagement is what writes a Recent. */
export type SearchEngagement = () => void;

export function SearchTrackResults({
  items,
  query,
  onEngage,
  onTrackRemoved,
}: {
  items: SearchTrackItem[];
  query: string;
  onEngage: SearchEngagement;
  /** A row's Track was deleted. */
  onTrackRemoved: () => void;
}) {
  const [selected, setSelected] = useState<SearchTrackItem | null>(null);
  const [pickerTrack, setPickerTrack] = useState<SavePickerTrack | null>(null);
  // Saves/favorites settle after the response rendered, so flag changes live
  // in an overlay; a new result set drops it.
  const [flagOverrides, setFlagOverrides] = useState<
    ReadonlyMap<string, { flags: TrackFlags; inCuratedPlaylist: boolean }>
  >(new Map());
  // Deleted tracks DO leave the list (unlike flag changes): the row names a
  // track that no longer exists anywhere.
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setFlagOverrides(new Map());
    setRemovedIds(new Set());
  }, [items]);

  const optionsOpenerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  function closeOptions() {
    setSelected(null);
    requestAnimationFrame(() => {
      const target = optionsOpenerRef.current?.isConnected
        ? optionsOpenerRef.current
        : listRef.current;
      target?.focus();
      optionsOpenerRef.current = null;
    });
  }

  function resolveFlags(trackId: string, flags: TrackFlags, inCuratedPlaylist: boolean) {
    setFlagOverrides((current) => new Map(current).set(trackId, { flags, inCuratedPlaylist }));
    setSelected((track) =>
      track?.id === trackId ? withSettledRetention(track, flags, inCuratedPlaylist) : track,
    );
  }

  // Search rows never disappear on a flag change (unlike the Saved tab), which
  // is exactly the History view's remove semantics.
  const actions = useLibraryActions({
    view: 'history',
    onFlagsResolved: resolveFlags,
    onTrackRemoved: (trackId) => {
      setRemovedIds((current) => new Set(current).add(trackId));
      onTrackRemoved();
    },
  });
  const playback = useTrackRowPlayback(toast.error);

  // Playing a result is an act on it, so the play goes out through engagement.
  function playRow(track: SearchTrackItem) {
    onEngage();
    playback.playRow(track);
  }

  function withFlags(track: SearchTrackItem): SearchTrackItem {
    const settled = flagOverrides.get(track.id);
    return settled ? withSettledRetention(track, settled.flags, settled.inCuratedPlaylist) : track;
  }

  return (
    <Sheet
      open={selected !== null}
      onOpenChange={(open) => !open && !actions.busyAction && closeOptions()}
    >
      <div ref={listRef} tabIndex={-1}>
        {items
          .filter((item) => !removedIds.has(item.id))
          .map((item) => {
            const track = withFlags(item);
            const availability = getTrackAvailability(track);
            const badges: TrackRowBadge[] = [];
            if (!availability.hasPlayed) badges.push({ label: 'Never played' });
            if (!availability.hasAudio) badges.push({ label: 'Audio unavailable' });
            return (
              <TrackRow
                key={track.id}
                track={track}
                metadata={formatLibraryTrackMetadata(track)}
                context={<MatchContextLine context={track.matchContext} query={query} />}
                badges={badges}
                previewState={
                  playback.rowPreview.trackId === track.id ? playback.rowPreview.state : 'idle'
                }
                busy={actions.busyAction?.trackId === track.id || playback.busyTrackId === track.id}
                onPreview={() => playRow(track)}
                onOptions={(opener) => {
                  optionsOpenerRef.current = opener;
                  onEngage();
                  setSelected(track);
                }}
              />
            );
          })}
      </div>

      {selected ? (
        <TrackOptionsSheet
          track={selected}
          busyAction={
            actions.busyAction?.trackId === selected.id ? actions.busyAction.action : null
          }
          onPlay={() => {
            playRow(selected);
            closeOptions();
          }}
          onUnsave={() => void actions.unsave(selected)}
          onOpenSavePicker={() =>
            setPickerTrack({
              id: selected.id,
              title: selected.title,
              savedAt: selected.savedAt,
              coverImageId: selected.coverImageId,
            })
          }
          onToggleFavorite={() => void actions.toggleFavorite(selected)}
          onMoreLikeThis={() => void actions.seedMoreLikeThis(selected)}
          onDelete={async () => {
            if (await actions.deleteTrack(selected)) closeOptions();
          }}
        />
      ) : null}

      <SaveToPlaylistSheet
        track={pickerTrack}
        onClose={() => setPickerTrack(null)}
        onApplied={(data) =>
          actions.applyPickerFlags(data.trackId, data.flags, data.inCuratedPlaylist)
        }
      />

      <audio ref={playback.audioRef} data-testid="search-audio" hidden {...playback.audioEvents} />
    </Sheet>
  );
}

const sessionGridClass = 'grid gap-2 desk:gap-3 @pair:grid-cols-2';

export function SearchSessionResults({
  items,
  query,
  onEngage,
}: {
  items: SearchSessionItem[];
  query: string;
  onEngage: SearchEngagement;
}) {
  return (
    <SessionTracksProvider>
      <div className="@container">
        <div className={sessionGridClass}>
          {items.map((session) => {
            const active = session.status === 'active';
            return (
              // `contents` keeps the card itself the grid item.
              <div key={session.id} className="contents" onClickCapture={onEngage}>
                <SessionCard
                  sessionId={session.id}
                  trackCount={session.trackCount}
                  active={active}
                  href={active ? '/player' : undefined}
                  title={session.title}
                  coverImageId={session.coverImageId}
                  genreTags={session.genreTags}
                  activityFallback={active ? 'Playing now' : 'Ready to continue'}
                  details={<MatchContextLine context={session.matchContext} query={query} />}
                />
              </div>
            );
          })}
        </div>
      </div>
    </SessionTracksProvider>
  );
}

/** The " · 2 MATCHES" tail of a playlist row's meta line; empty when none matched. */
function memberMatchLabel(count: number): string {
  if (count === 0) return '';
  return ` · ${count} ${count === 1 ? 'MATCH' : 'MATCHES'}`;
}

/** The marking a Lounge-pinned foreign playlist carries: pin, avatar, owner. */
function PinnedOwnerLine({ owner, testId }: { owner: LoungePlaylistOwner; testId: string }) {
  const label = loungeOwnerDisplayName(owner.artistName, owner.name);
  return (
    <span
      className="mt-[3px] flex items-center gap-1 font-mono text-[10.5px] tracking-[0.04em] text-dim"
      data-testid={testId}
    >
      <Pin className="h-3 w-3 shrink-0 fill-current text-lamp" aria-hidden />
      <AvatarBadge
        name={label}
        imageUrl={owner.imageUrl}
        className="h-[18px] w-[18px] text-[9px]"
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

export function SearchPlaylistResults({
  items,
  query,
  onEngage,
}: {
  items: SearchPlaylistItem[];
  query: string;
  onEngage: SearchEngagement;
}) {
  return (
    <div>
      {/* A set `owner` is a Lounge-pinned foreign playlist: it ranks
          among the viewer's own here — same row, visibly foreign, opening the
          read-only visitor view. */}
      {items.map((playlist) => (
        <Link
          key={playlist.id}
          href={
            playlist.owner ? `/lounge/playlist/${playlist.id}` : `/library/playlist/${playlist.id}`
          }
          onClick={onEngage}
          className="grid grid-cols-[48px_minmax(0,1fr)] items-center gap-3 border-b border-line py-2 last:border-b-0 hover:bg-paper/[0.02]"
        >
          <PlaylistCover
            coverImageId={playlist.coverImageId}
            mosaicCoverImageIds={playlist.mosaicCoverImageIds}
            className="h-12 w-12 rounded-[10px]"
            thumb
          />
          <span className="min-w-0">
            <span className="block truncate text-[14.5px] font-semibold">{playlist.name}</span>
            <span className="mt-[3px] block truncate font-mono text-[10.5px] tracking-[0.04em] text-dim">
              <OfflineMark kind="playlist" id={playlist.id} />
              {formatPlaylistTrackCount(playlist.trackCount).toUpperCase()}
              {memberMatchLabel(playlist.memberMatchCount)}
            </span>
            {playlist.owner ? (
              <PinnedOwnerLine
                owner={playlist.owner}
                testId={`search-playlist-pinned-${playlist.id}`}
              />
            ) : null}
            <MatchContextLine context={playlist.matchContext} query={query} />
          </span>
        </Link>
      ))}
    </div>
  );
}
