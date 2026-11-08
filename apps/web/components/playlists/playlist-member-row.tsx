'use client';

import type { CSSProperties, ReactNode, Ref } from 'react';
import type { PlaylistMemberItem } from '@liedmotif/shared';
import { cn } from '@/lib/cn';
import { TrackRow } from '@/components/library/track-row';
import { formatPlaylistMemberMetadata } from './playlist-view-model';

/**
 * One Playlist member row, shared by the plain list and the reorder mode. The
 * sortable variant injects its drag affordances (`grip`, `containerRef`,
 * `style`, `className`); the plain variant renders none of them and keeps the
 * per-row `⋮` via `onOptions`.
 */
export function PlaylistMemberRow({
  item,
  onPlay,
  onOptions,
  grip,
  containerRef,
  style,
  className,
}: {
  item: PlaylistMemberItem;
  onPlay: () => void;
  onOptions?: () => void;
  grip?: ReactNode;
  containerRef?: Ref<HTMLDivElement>;
  style?: CSSProperties;
  className?: string;
}) {
  const title = item.title ?? 'Untitled Track';
  return (
    <div
      ref={containerRef}
      style={style}
      className={cn(
        // The rule belongs to the member, not to the row inside it: a TrackRow
        // is an only child here, so its own last-child rule would drop every one.
        // It hangs off the top edge because in reorder mode DndContext renders
        // hidden accessibility nodes after the members — the last member is
        // never `:last-child` there, but the first is always `:first-child`.
        'grid items-center gap-2 border-t border-line first:border-t-0',
        grip ? 'grid-cols-[20px_minmax(0,1fr)]' : 'grid-cols-[minmax(0,1fr)]',
        className,
      )}
      data-testid="playlist-member"
      data-track-id={item.id}
      data-position={item.position}
    >
      {grip}
      <TrackRow
        track={item}
        metadata={formatPlaylistMemberMetadata(item)}
        previewState="idle"
        busy={false}
        onPreview={onPlay}
        onOptions={onOptions}
        optionsLabel={`Options for ${title}`}
        minimalCoverRounding
      />
    </div>
  );
}
