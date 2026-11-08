'use client';

// The Playlist's members, in the owner's order. Reordering is a mode rather
// than a handle that sits in every row forever: outside it a row carries its
// own `⋮`, inside it a grip takes the row's left edge and the `⋮` steps out, so
// the mode's Cancel can only ever mean "undo the order". The common case is a
// plain list; the dnd-kit machinery loads on demand when the mode is entered.

import dynamic from 'next/dynamic';
import type { PlaylistMemberItem } from '@liedmotif/shared';
import { PlaylistMemberRow } from './playlist-member-row';

const SortablePlaylistMemberList = dynamic(
  () => import('./sortable-playlist-member-list').then((m) => m.SortablePlaylistMemberList),
  { ssr: false },
);

export function PlaylistMemberList({
  items,
  reordering,
  onReorder,
  onPlayFrom,
  onOpenOptions,
}: {
  items: PlaylistMemberItem[];
  reordering: boolean;
  /** The whole list in its new order — the mode buffers it until Done. */
  onReorder: (items: PlaylistMemberItem[]) => void;
  onPlayFrom: (trackId: string) => void;
  onOpenOptions: (item: PlaylistMemberItem) => void;
}) {
  if (reordering) {
    return (
      <SortablePlaylistMemberList items={items} onReorder={onReorder} onPlayFrom={onPlayFrom} />
    );
  }
  return items.map((item) => (
    <PlaylistMemberRow
      key={item.id}
      item={item}
      onPlay={() => onPlayFrom(item.id)}
      onOptions={() => onOpenOptions(item)}
    />
  ));
}
