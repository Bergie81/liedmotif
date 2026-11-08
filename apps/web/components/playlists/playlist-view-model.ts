// What more than one Playlist surface has to agree on: which playlists a
// surface offers, and the copy it renders. The delete confirmation is the
// load-bearing one: the grid menu and the detail page must promise the owner
// exactly the same thing about Tracks that would leave the Library (retention
// is membership).

import { MENU_COPY } from '@/components/ui/menu-copy';
import {
  isOwnerNamedPlaylist,
  MAX_PLAYLIST_ORDER_TRACKS,
  type PlaylistMemberItem,
  type PlaylistSummaryItem,
} from '@liedmotif/shared';
import {
  formatCollectionLength,
  formatTrackDuration,
} from '@/components/library/library-view-model';
import { loungeOwnerDisplayName } from '@/components/lounge/lounge-view-model';

/** How many genres a member row can carry before it overruns a phone. */
const ROW_GENRE_LIMIT = 2;

/**
 * A member row's mono line: duration first, then genres. Duration is the field
 * every row has and the one the eye scans down a column; genre qualifies it.
 * The origin Session stays out — inside a Playlist the owner's order is the
 * context, not where each Track came from. A Shared reference leads
 * with its owner instead: attribution is the one fact a foreign row must
 * always carry.
 */
export function formatPlaylistMemberMetadata(
  item: Pick<PlaylistMemberItem, 'durationSeconds' | 'genreTags'> &
    Partial<Pick<PlaylistMemberItem, 'owner'>>,
): string {
  return [
    item.owner ? `BY ${loungeOwnerDisplayName(item.owner.artistName, item.owner.name)}` : '',
    formatTrackDuration(item.durationSeconds),
    item.genreTags.slice(0, ROW_GENRE_LIMIT).join(', ').toUpperCase(),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** How many members a detail surface loads per page (server render and Load more). */
export const PLAYLIST_DETAIL_PAGE_LIMIT = 50;

// Member paging: the loaded list is always a dense prefix of the server order
// (positions 0..n-1) — pages extend it and every removal reindexes it — so the
// live `trackCount` says whether more remains and the last loaded position IS
// the next keyset cursor, even after removals moved the server's positions.

/** Whether members beyond the loaded prefix remain server-side. */
export function hasUnloadedMembers(
  items: readonly Pick<PlaylistMemberItem, 'position'>[],
  trackCount: number,
): boolean {
  return items.length < trackCount;
}

/** The next member page's cursor: the last loaded position, or null from nothing. */
export function nextMemberCursor(
  items: readonly Pick<PlaylistMemberItem, 'position'>[],
): string | null {
  const last = items[items.length - 1];
  return last ? String(last.position) : null;
}

/** Restore the dense 0..n-1 positions after a local removal or reorder —
 *  mirroring the server's own dense resequencing, so the prefix invariant holds. */
export function reindexMembers(items: PlaylistMemberItem[]): PlaylistMemberItem[] {
  return items.map((item, index) => ({ ...item, position: index }));
}

/** Whether a list still stands in the given order — what tells the reorder mode
 *  it has nothing to commit. */
export function sameTrackOrder(items: readonly { id: string }[], trackIds: string[]): boolean {
  return (
    items.length === trackIds.length && items.every((item, index) => item.id === trackIds[index])
  );
}

/**
 * A playlist's member count. Distinct from the Sessions formatter of the same
 * shape: an empty playlist reads `0 Tracks`, because the owner made it and the
 * count is a fact about it, where an empty Session reads `No Tracks yet`.
 */
export function formatPlaylistTrackCount(count: number): string {
  return `${count} ${count === 1 ? 'Track' : 'Tracks'}`;
}

/**
 * A card's first meta line: member count, then total playtime. An empty playlist
 * claims no playtime at all.
 */
export function formatPlaylistCardMeta(
  playlist: Pick<PlaylistSummaryItem, 'trackCount' | 'totalDurationSeconds'>,
): string {
  const count = formatPlaylistTrackCount(playlist.trackCount);
  if (playlist.totalDurationSeconds <= 0) return count;
  return `${count} · ${formatCollectionLength(playlist.totalDurationSeconds)}`;
}

/**
 * Whether the Playlist zip has anything to carry. Gates every download row: a
 * playlist of only Shared references or stream-only members still has
 * members, and the route answers an empty selection with a bare 404 page that
 * leaves the app and stops the player.
 */
export function canDownloadPlaylist(
  playlist: Pick<PlaylistSummaryItem, 'downloadableTrackCount'>,
): boolean {
  return playlist.downloadableTrackCount > 0;
}

/** The acts the Playlist screen keeps behind its one `⋯` — every act that
 *  manages the Playlist rather than plays it. */
export type PlaylistMenuRowId =
  'add-tracks' | 'rename' | 'reorder' | 'cover' | 'download' | 'delete';

export interface PlaylistMenuRow {
  id: PlaylistMenuRowId;
  label: string;
  description: string;
  disabled: boolean;
  /** Why the row is dark. */
  note?: string;
  tone?: 'danger';
}

/**
 * What the curation menu offers this Playlist. Favorites is the same chassis
 * with the acts it does not have knocked out, and an act with nothing to work on
 * stays in place rather than moving every row below it.
 */
export function playlistMenuRows(
  playlist: Pick<
    PlaylistSummaryItem,
    'kind' | 'coverImageId' | 'trackCount' | 'downloadableTrackCount'
  >,
): PlaylistMenuRow[] {
  const ownerNamed = isOwnerNamedPlaylist(playlist.kind);
  const tooManyToReorder = playlist.trackCount > MAX_PLAYLIST_ORDER_TRACKS;
  const rows: PlaylistMenuRow[] = [
    {
      id: 'add-tracks',
      label: 'Add Tracks',
      description: MENU_COPY.addTracksFromHistory,
      disabled: false,
    },
    {
      id: 'rename',
      label: 'Rename Playlist',
      description: MENU_COPY.renamePlaylist,
      disabled: false,
    },
    {
      id: 'reorder',
      label: 'Reorder Tracks',
      description: 'Change the order its tracks play in',
      disabled: tooManyToReorder || playlist.trackCount < 2,
      note: tooManyToReorder ? 'Too many Tracks' : undefined,
    },
    {
      id: 'cover',
      label: playlist.coverImageId ? 'Edit Playlist Cover' : 'Add Playlist Cover',
      description: MENU_COPY.chooseCover,
      disabled: false,
    },
    {
      id: 'download',
      label: 'Download all Playlist Tracks',
      description: MENU_COPY.downloadAllTracks,
      disabled: !canDownloadPlaylist(playlist),
    },
    {
      id: 'delete',
      label: 'Delete Playlist',
      description: MENU_COPY.deletePlaylist,
      disabled: false,
      tone: 'danger',
    },
  ];
  return ownerNamed ? rows : rows.filter((row) => !OWNER_NAMED_ROW_IDS.includes(row.id));
}

/** Rows only a playlist the owner made and named can answer for. */
const OWNER_NAMED_ROW_IDS: readonly PlaylistMenuRowId[] = ['rename', 'delete'];

export function deletePlaylistConfirmBody(
  playlist: Pick<PlaylistSummaryItem, 'name' | 'soleMemberTrackCount'>,
): string {
  const sole = playlist.soleMemberTrackCount;
  if (sole === 0) {
    return `Delete “${playlist.name}”? Its Tracks stay in your Library through their other playlists.`;
  }
  return `${sole} ${sole === 1 ? 'Track is' : 'Tracks are'} only in this playlist and will leave your Library (they stay in History). Delete “${playlist.name}”?`;
}

/** What a refused Pin toggle reports, on every surface that offers one. */
export function pinToggleFailure(pinned: boolean, message: string): string {
  return `Couldn’t ${pinned ? 'pin' : 'unpin'} the playlist: ${message}`;
}
