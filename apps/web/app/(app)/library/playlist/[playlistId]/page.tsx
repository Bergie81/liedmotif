import { uuidSchema } from '@liedmotif/shared';
import { PlaylistDetail } from '@/components/playlists/playlist-detail';
import { PLAYLIST_DETAIL_PAGE_LIMIT } from '@/components/playlists/playlist-view-model';
import { getDb } from '@/lib/db';
import { loadPlaylistDetailPage } from '@/lib/library/playlists';
import { requireAppAccess } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function PlaylistPage({
  params,
}: {
  params: Promise<{ playlistId: string }>;
}) {
  const { playlistId } = await params;
  // The layout already guards; the request-scoped cache makes re-asking free.
  // Server-load the first member page so the page paints with content. A
  // missing/foreign id renders without initial data — the client's own load
  // then surfaces the not-found error. A malformed id never reaches the query,
  // where Postgres would reject it as a uuid and fail the whole page.
  const { session } = await requireAppAccess();
  const initial = uuidSchema.safeParse(playlistId).success
    ? await loadPlaylistDetailPage(getDb(), session.user.id, playlistId, PLAYLIST_DETAIL_PAGE_LIMIT)
    : null;
  return (
    <div className="mx-auto max-w-[760px]">
      <PlaylistDetail
        playlistId={playlistId}
        back={{ href: '/library', label: 'Library' }}
        {...(initial ? { initial } : {})}
      />
    </div>
  );
}
