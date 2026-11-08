import { MySessionsList } from '@/components/sessions/my-sessions-list';
import { displayHeadingClass } from '@/components/ui/design-system';
import { getDb } from '@/lib/db';
import { requireAppAccess } from '@/lib/session';
import { loadSessionList } from '@/lib/sessions';

// My Sessions: resumable Stopped sessions, session-centric and distinct from
// the track-centric Library. The auth guard lives in the (app) layout; the
// request-scoped guard cache makes re-asking here free, and the first page of
// sessions rides the server render instead of a post-hydration fetch.
export const dynamic = 'force-dynamic';

export default async function SessionsPage() {
  const { session } = await requireAppAccess();
  const initial = await loadSessionList(getDb(), session.user.id, {
    limit: 20,
    includeActive: true,
    includePinned: true,
  });
  return (
    <>
      <header>
        <h1 className={`${displayHeadingClass} mb-2`}>Pick up where you left off</h1>
        <p className="text-[14.5px] text-muted">
          A Session remembers its style, queue and position. Resume any of them — it’s free until
          fresh music is needed.
        </p>
      </header>
      <MySessionsList initial={initial} />
    </>
  );
}
