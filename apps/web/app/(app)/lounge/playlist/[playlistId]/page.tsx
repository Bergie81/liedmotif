import { uuidSchema } from '@liedmotif/shared';
import { PlaylistDetail } from '@/components/playlists/playlist-detail';
import { PLAYLIST_DETAIL_PAGE_LIMIT } from '@/components/playlists/playlist-view-model';
import { getDb } from '@/lib/db';
import { loadLoungePlaylistDetailPage } from '@/lib/library/lounge';
import { requireAppAccess } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

// The visitor view: another owner's In-Lounge playlist, rendered by
// the one playlist detail surface in its read-only visitor scope — attributed,
// playable, no curation anywhere. An unknown, private, or revoked id renders
// without initial data and the client's own load surfaces the uniform
// not-found, exactly like a foreign id on the owner's detail page. A malformed
// id skips the read: Postgres would reject it as a uuid and fail the page.

export default async function LoungePlaylistPage({
  params,
}: {
  params: Promise<{ playlistId: string }>;
}) {
  const { playlistId } = await params;
  const { session, role } = await requireAppAccess();
  const initial = uuidSchema.safeParse(playlistId).success
    ? await loadLoungePlaylistDetailPage(getDb(), session.user.id, {
        playlistId,
        limit: PLAYLIST_DETAIL_PAGE_LIMIT,
      })
    : null;
  return (
    <div className="mx-auto max-w-[760px]">
      <PlaylistDetail
        playlistId={playlistId}
        back={{ href: '/lounge', label: 'Lounge' }}
        visitor={{
          owner: initial?.owner ?? null,
          pinned: initial?.pinned ?? false,
          isAdmin: role === 'admin',
        }}
        {...(initial ? { initial: { playlist: initial.playlist, items: initial.items } } : {})}
      />
    </div>
  );
}
