// Map playlists-repo rows to the contract payloads (`playlistSummarySchema`,
// `playlistMemberItemSchema`), plus the shared server-side loaders the API
// routes AND the server components use — a page's first paint carries the same
// contract-shaped data its client controller later revalidates over HTTP.
// Member audio follows the ONE audio rule via `toTrackSummary` —
// same-origin `/api/audio/<id>` paths only.

import {
  ensureFavoritesPlaylist,
  getPlaylistDetail,
  listPlaylistsPage,
  type Database,
  type PlaylistMemberTrack,
  type PlaylistSummary,
} from '@liedmotif/db';
import type { PlaylistMemberItem, PlaylistSummaryItem } from '@liedmotif/shared';
import { toTrackSummary } from '@/lib/tracks';

export function toPlaylistSummaryItem(playlist: PlaylistSummary): PlaylistSummaryItem {
  return {
    id: playlist.id,
    name: playlist.name,
    kind: playlist.kind,
    listedInPlaylists: playlist.listedInPlaylists,
    trackCount: playlist.trackCount,
    totalDurationSeconds: playlist.totalDurationSeconds,
    downloadableTrackCount: playlist.downloadableTrackCount,
    coverImageId: playlist.coverImageId,
    mosaicCoverImageIds: playlist.mosaicCoverImageIds,
    soleMemberTrackCount: playlist.soleMemberTrackCount,
    soleMemberDeletedTrackCount: playlist.soleMemberDeletedTrackCount,
    containsTrack: playlist.containsTrack,
    sharedAt: playlist.sharedAt ? playlist.sharedAt.toISOString() : null,
    pinnedAt: playlist.pinnedAt ? playlist.pinnedAt.toISOString() : null,
    createdAt: playlist.createdAt.toISOString(),
    updatedAt: playlist.updatedAt.toISOString(),
  };
}

export function toPlaylistMemberItem(member: PlaylistMemberTrack): PlaylistMemberItem {
  const summary = toTrackSummary(member);
  const owner = member.owner ?? null;
  return {
    ...summary,
    // Downloads never widen: a Shared reference is streamable but
    // must not offer the owner's local final.
    downloadable: owner ? false : summary.downloadable,
    position: member.position,
    originSessionTitle: member.originSessionTitle,
    // A Shared reference carries its owner's attribution; the reader's own
    // tracks carry none.
    owner,
  };
}

/**
 * One page of the owner's playlist summaries as the contract shape (Favorites
 * ensured and riding the first page, mirroring `GET /api/playlists`). Shared
 * by that route and the Library page's server render.
 */
export async function loadPlaylistSummaries(
  db: Database,
  ownerUserId: string,
  args: {
    containsTrackId?: string | null;
    search?: string | null;
    cursor?: string | null;
    limit: number;
  },
): Promise<{ playlists: PlaylistSummaryItem[]; nextCursor: string | null }> {
  // Favorites always exists once the owner looks at playlists, so the picker
  // and the star toggle always have the system playlist to offer (story 6).
  await ensureFavoritesPlaylist(db, { ownerUserId });
  const page = await listPlaylistsPage(db, {
    ownerUserId,
    containsTrackId: args.containsTrackId ?? null,
    search: args.search ?? null,
    cursor: args.cursor ?? null,
    limit: args.limit,
  });
  return { playlists: page.items.map(toPlaylistSummaryItem), nextCursor: page.nextCursor };
}

/**
 * One playlist with the FIRST page of its ordered membership, contract-shaped —
 * the detail page's server render. The client pages the rest on demand and
 * derives "more remains" from the summary's live `trackCount`, so no cursor
 * travels with the render. Null when absent/not owned.
 */
export async function loadPlaylistDetailPage(
  db: Database,
  ownerUserId: string,
  playlistId: string,
  limit: number,
): Promise<{ playlist: PlaylistSummaryItem; items: PlaylistMemberItem[] } | null> {
  const page = await getPlaylistDetail(db, { ownerUserId, playlistId, cursor: null, limit });
  if (!page) return null;
  return {
    playlist: toPlaylistSummaryItem(page.playlist),
    items: page.items.map(toPlaylistMemberItem),
  };
}
