'use client';

import type { ReactNode } from 'react';
import type { PlaylistSummaryItem } from '@liedmotif/shared';
import { OfflineMenuRow } from '@/components/offline/offline-menu-row';
import { SheetContent, SheetHeader } from '@/components/ui/sheet';
import { PlaylistCover } from './playlist-cover';
import { formatPlaylistCardMeta } from './playlist-view-model';

/** A Playlist's options sheet wherever it opens from: it names the Playlist it
 *  acts on, and Available offline leads the rows. */
export function PlaylistOptionsSheetContent({
  playlist,
  owner,
  children,
}: {
  playlist: Pick<
    PlaylistSummaryItem,
    'id' | 'name' | 'coverImageId' | 'mosaicCoverImageIds' | 'trackCount' | 'totalDurationSeconds'
  >;
  /** Whose Playlist it is, where that is not the viewer's. */
  owner?: string;
  children?: ReactNode;
}) {
  return (
    <SheetContent side="bottom" className="overflow-y-auto">
      <SheetHeader
        title={playlist.name}
        closeLabel={`Close options for ${playlist.name}`}
        description={
          <span className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-dim">
            {owner ? `${owner} · ` : null}
            {formatPlaylistCardMeta(playlist)}
          </span>
        }
        leading={
          <PlaylistCover
            coverImageId={playlist.coverImageId}
            mosaicCoverImageIds={playlist.mosaicCoverImageIds}
            thumb
            className="h-12 w-12 shrink-0 rounded-[10px]"
          />
        }
      />
      <div className="mt-4">
        <OfflineMenuRow kind="playlist" id={playlist.id} />
        {children}
      </div>
    </SheetContent>
  );
}
