// Map the Lounge repo rows to the contract payload (`loungePlaylistItemSchema`)
// and share the loader between the API route and the Lounge page's server
// render — the first paint carries the same contract-shaped data the client
// later pages over HTTP. The listing query decides WHICH playlists the viewer
// sees; `yours` is presentation derived here.

import {
  getLoungePlaylistDetail,
  isPlaylistLoungePinned,
  listLoungePlaylistsPage,
  type Database,
  type LoungePlaylistRow,
} from '@liedmotif/db';
import type {
  LoungePlaylistItem,
  LoungePlaylistOwner,
  PlaylistMemberItem,
  PlaylistSummaryItem,
} from '@liedmotif/shared';
import { toPlaylistMemberItem, toPlaylistSummaryItem } from '@/lib/library/playlists';

export function toLoungePlaylistItem(
  row: LoungePlaylistRow,
  viewerUserId: string,
): LoungePlaylistItem {
  return {
    id: row.id,
    name: row.name,
    trackCount: row.trackCount,
    totalDurationSeconds: row.totalDurationSeconds,
    coverImageId: row.coverImageId,
    mosaicCoverImageIds: row.mosaicCoverImageIds,
    sharedAt: row.sharedAt.toISOString(),
    yours: row.owner.userId === viewerUserId,
    pinned: row.pinned,
    ownerName: row.owner.name,
    ownerArtistName: row.owner.artistName,
    ownerImageUrl: row.owner.imageUrl,
    matchContext: row.match,
  };
}

/** One page of the Lounge, contract-shaped, the viewer's Pins first, then
 *  newest-shared first. `query` and `owner` narrow it (filter semantics — the
 *  order never changes). */
export async function loadLoungePlaylists(
  db: Database,
  viewerUserId: string,
  args: { cursor?: string | null; limit: number; query?: string | null; owner?: string | null },
): Promise<{ playlists: LoungePlaylistItem[]; nextCursor: string | null }> {
  const page = await listLoungePlaylistsPage(db, {
    viewerUserId,
    cursor: args.cursor ?? null,
    limit: args.limit,
    query: args.query ?? null,
    ownerUserId: args.owner ?? null,
  });
  return {
    playlists: page.items.map((item) => toLoungePlaylistItem(item, viewerUserId)),
    nextCursor: page.nextCursor,
  };
}

export interface LoungePlaylistDetailPage {
  playlist: PlaylistSummaryItem;
  owner: LoungePlaylistOwner;
  /** Whether the viewer pinned this playlist — the detail's Pin toggle state. */
  pinned: boolean;
  items: PlaylistMemberItem[];
  nextCursor: string | null;
}

/**
 * One playlist in the viewer's Lounge, contract-shaped — shared by
 * `GET /api/lounge/playlist` and the visitor page's server render. Null when
 * unknown, private, revoked, or outside its audience (the callers' uniform
 * 404).
 */
export async function loadLoungePlaylistDetailPage(
  db: Database,
  viewerUserId: string,
  args: { playlistId: string; cursor?: string | null; limit: number },
): Promise<LoungePlaylistDetailPage | null> {
  const page = await getLoungePlaylistDetail(db, {
    viewerUserId,
    playlistId: args.playlistId,
    cursor: args.cursor ?? null,
    limit: args.limit,
  });
  if (!page) return null;
  const pinned = await isPlaylistLoungePinned(db, { viewerUserId, playlistId: args.playlistId });
  return {
    playlist: toPlaylistSummaryItem(page.playlist),
    owner: {
      name: page.owner.name,
      artistName: page.owner.artistName,
      imageUrl: page.owner.imageUrl,
    },
    pinned,
    items: page.items.map(toPlaylistMemberItem),
    nextCursor: page.nextCursor,
  };
}
