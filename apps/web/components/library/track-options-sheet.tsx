'use client';

import Image from 'next/image';
import type { TrackSummary } from '@liedmotif/shared';
import { Bookmark, Disc3, Download, Play, Plus, Star } from 'lucide-react';
import { MenuMoreLikeThisGlyph } from '@/components/ui/glyphs';
import { coverArtSrc } from '@/components/player/player-presentation';
import { SheetContent, SheetHeader } from '@/components/ui/sheet';
import { MenuRow } from '@/components/ui/menu-row';
import { startFileDownload, trackDownloadUrl } from '@/lib/downloads/downloads';
import { DeleteTrackMenuRow } from './delete-track-menu-row';
import { formatTrackDuration, trackDownloadNote } from './library-view-model';
import type { LibraryActionName } from './use-library-actions';

export function TrackOptionsSheet({
  track,
  busyAction,
  onUnsave,
  onOpenSavePicker,
  onToggleFavorite,
  onMoreLikeThis,
  onPlay,
  onDelete,
}: {
  track: TrackSummary & { originSessionTitle: string | null };
  busyAction: LibraryActionName | null;
  /** Remove from the Library (every playlist) — the saved-track row. */
  onUnsave: () => void;
  /** Open the playlist picker (saving / managing memberships). */
  onOpenSavePicker: () => void;
  onToggleFavorite: () => void;
  onMoreLikeThis: () => void;
  onPlay: () => void;
  /** Permanently delete the Track everywhere — only ever called confirmed. */
  onDelete: () => Promise<void> | void;
}) {
  const locked = busyAction !== null;
  // A failed Track's final never arrived: it can leave Favorites but not join them.
  const failed = track.status === 'failed';
  return (
    <SheetContent side="bottom" className="overflow-y-auto">
      <SheetHeader
        title={track.title ?? 'Untitled Track'}
        closeDisabled={locked}
        description={
          <span className="font-mono text-[10.5px] tracking-[0.04em] text-dim">
            {(track.originSessionTitle?.trim() || 'Untitled Session').toUpperCase()} ·{' '}
            {formatTrackDuration(track.durationSeconds)}
          </span>
        }
        leading={
          <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-[10px] bg-panel-2">
            {track.coverImageId ? (
              <Image
                src={coverArtSrc(track.coverImageId, 'thumb')}
                alt=""
                fill
                className="object-cover"
              />
            ) : (
              <Disc3 className="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 text-muted" />
            )}
          </div>
        }
      />
      <div className="mt-4">
        <MenuRow
          icon={<Play className="fill-current" />}
          label="Play now"
          description="Start this track right away"
          disabled={locked || !track.audioUrl}
          onClick={onPlay}
        />
        <MenuRow
          onlineOnly
          icon={<MenuMoreLikeThisGlyph />}
          label="More Like This"
          description="Start a new session seeded from this track"
          busy={busyAction === 'seed'}
          disabled={locked}
          onClick={onMoreLikeThis}
        />
        <MenuRow
          onlineOnly
          icon={<Star className={track.favoritedAt ? 'fill-current' : ''} />}
          label={track.favoritedAt ? 'Remove from Favorites' : 'Add to Favorites'}
          description={
            track.favoritedAt
              ? 'Take it out of your favorites playlist'
              : 'Keep it in your favorites playlist'
          }
          busy={busyAction === 'favorite'}
          disabled={locked || (failed && !track.favoritedAt)}
          onClick={onToggleFavorite}
        />
        {/* The one way into the Library: retention IS membership, so
            filing a Track is choosing its Playlists and there is nothing else to
            call Saving. The row states its shelf in the footnote rather than the
            label, because every row here reads as an act. It may only report
            `inCuratedPlaylist`: the star above sets `savedAt` too, so a row lit
            from that flag would claim this Track had been filed into Playlists
            the owner never picked. */}
        <MenuRow
          onlineOnly
          icon={<Plus />}
          label="Add to Playlist"
          description="Choose which playlists it belongs to"
          note={track.inCuratedPlaylist ? 'In a Playlist' : undefined}
          disabled={locked}
          data-testid="library-add-to-playlist"
          onClick={onOpenSavePicker}
        />
        <MenuRow
          onlineOnly
          icon={<Download />}
          label="Download Track"
          description="Save this track as a fully tagged MP3"
          note={trackDownloadNote(track)}
          disabled={locked || !track.downloadable}
          data-testid="library-download-track"
          onClick={() => startFileDownload(trackDownloadUrl(track.id))}
        />
        {/* Unsave is the exception the picker cannot express in one tap: leaving
            EVERY Playlist at once. An Ephemeral Track has nothing to leave. */}
        {track.savedAt ? (
          <MenuRow
            onlineOnly
            icon={<Bookmark className="fill-current" />}
            label="Remove from Library"
            description="Take it out of favorites and every playlist"
            busy={busyAction === 'save'}
            disabled={locked}
            onClick={onUnsave}
          />
        ) : null}
        <DeleteTrackMenuRow
          title={track.title ?? 'Untitled Track'}
          testId="library-delete-track"
          busy={busyAction === 'delete'}
          disabled={locked}
          onDelete={onDelete}
        />
      </div>
    </SheetContent>
  );
}
