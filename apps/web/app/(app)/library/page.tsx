import { DEFAULT_PLAYLISTS_LIST_PAGE_LIMIT } from '@liedmotif/shared';
import { LibraryView } from '@/components/library/library-view';
import { displayHeadingClass } from '@/components/ui/design-system';
import { getDb } from '@/lib/db';
import { loadPlaylistSummaries } from '@/lib/library/playlists';
import { requireAppAccess } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function LibraryPage() {
  // The layout already guards; the request-scoped cache makes re-asking free,
  // and the default tab's playlists ride the server render.
  const { session } = await requireAppAccess();
  const initialPlaylists = await loadPlaylistSummaries(getDb(), session.user.id, {
    limit: DEFAULT_PLAYLISTS_LIST_PAGE_LIMIT,
  });
  return (
    <>
      <header>
        <h1 className={`${displayHeadingClass} mb-2`}>Your saved music</h1>
        <p className="text-[14.5px] text-muted">
          Add a Track to a Playlist to keep it. Other Tracks go when you delete their Session.
        </p>
      </header>
      <LibraryView initialPlaylists={initialPlaylists} />
    </>
  );
}
