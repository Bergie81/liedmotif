import { MySessionsList } from '@/components/sessions/my-sessions-list';
import { displayHeadingClass } from '@/components/ui/design-system';
import { getDb } from '@/lib/db';
import { requireAppAccess } from '@/lib/auth/session';
import { loadSessionList } from '@/lib/sessions/sessions';

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
        <h1 className={`${displayHeadingClass} mb-2`}>Pick Up Where You Left Off</h1>
        <p className="text-[14.5px] text-muted">
          Pick Resume Session in a session’s menu to keep listening from where you stopped, or tap
          it to choose a track. Its tracks replay for free, and with New Music on it keeps making
          fresh ones in the same style.
        </p>
      </header>
      <MySessionsList initial={initial} />
    </>
  );
}
