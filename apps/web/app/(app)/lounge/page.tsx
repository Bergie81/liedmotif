import { listLoungeSharers } from '@liedmotif/db';
import { DEFAULT_LOUNGE_PAGE_LIMIT } from '@liedmotif/shared';
import { LoungeView } from '@/components/lounge/lounge-view';
import { displayHeadingClass } from '@/components/ui/design-system';
import { getDb } from '@/lib/db';
import { loadLoungePlaylists } from '@/lib/library/lounge';
import { requireAppAccess } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

// The Lounge page: every signed-in User has one — the
// layout guard is the whole gate — and each sees the playlists shared with
// everyone or with them by name. On a solo Instance the room is simply empty:
// the teach panel explains the share move, so the page is meaningful before
// the first invite.

export default async function LoungePage() {
  const { session, role } = await requireAppAccess();
  const [initial, sharers] = await Promise.all([
    loadLoungePlaylists(getDb(), session.user.id, { limit: DEFAULT_LOUNGE_PAGE_LIMIT }),
    listLoungeSharers(getDb(), { viewerUserId: session.user.id }),
  ]);
  return (
    <>
      <header>
        <h1 className={`${displayHeadingClass} mb-2`}>Share Your Music</h1>
        <p className="text-[14.5px] text-muted">
          Playlists the people here have set out to play. Listen, pin, save what you like — it stays
          yours while they keep sharing it.
        </p>
      </header>
      <LoungeView
        initial={initial}
        sharers={sharers}
        viewerUserId={session.user.id}
        viewerIsAdmin={role === 'admin'}
      />
    </>
  );
}
