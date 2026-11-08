'use client';

import Link from 'next/link';
import { RotateCcw } from 'lucide-react';
import { cn } from '@/lib/cn';
import { MOBILE_RECENT_SESSIONS_LIMIT } from '@/lib/constants';
import { AlertBanner, cardClass, sectionHeadingClass } from '@/components/ui/design-system';
import { LoadingRow } from '@/components/ui/loading';
import { SessionCard, SessionCardLastActiveDetails } from '@/components/sessions/session-card';
import { SessionTracksProvider } from '@/components/sessions/session-tracks-sheet';
import type { ResumableSessionsState } from '@/components/sessions/use-resumable-sessions';

/**
 * Whether the resume rail has anything to say. An owner with no Sessions yet gets
 * no heading and no banner at all — the rail is absent, not empty.
 */
function hasResumableRail(state: ResumableSessionsState): boolean {
  return state.items === null || state.items.length > 0 || state.error !== null;
}

export function RecentSessions({ state }: { state: ResumableSessionsState }) {
  const { items, error, retry } = state;
  if (!hasResumableRail(state)) return null;

  return (
    <aside className="mb-12 @split:sticky @split:top-6 @split:col-start-2 @split:row-start-1 @split:mb-0">
      <h2 className={cn(sectionHeadingClass, 'mb-3 mt-6 flex items-center justify-between gap-2')}>
        Jump back in
        <Link
          href="/sessions"
          className="font-mono text-[12px] font-normal tracking-[0.06em] text-dim hover:text-muted"
        >
          ALL SESSIONS →
        </Link>
      </h2>

      {items === null && !error ? (
        <LoadingRow className={cn(cardClass, 'py-10')} label="Loading Sessions…" />
      ) : null}

      <SessionTracksProvider>
        {items?.map((session, index) => (
          <SessionCard
            sessionId={session.id}
            trackCount={session.trackCount}
            key={session.id}
            title={session.title}
            coverImageId={session.coverImageId}
            genreTags={session.genreTags}
            activityFallback="Stopped Session"
            coverVariant={index}
            className={cn('mb-2', index >= MOBILE_RECENT_SESSIONS_LIMIT && '@max-split:hidden')}
            details={
              <SessionCardLastActiveDetails
                trackCount={session.trackCount}
                totalDurationSeconds={session.totalDurationSeconds}
                lastActiveAt={session.lastActiveAt}
              />
            }
          />
        ))}
      </SessionTracksProvider>

      {error ? (
        <AlertBanner>
          <p>{error}</p>
          <button
            type="button"
            onClick={retry}
            className="mt-3 inline-flex items-center gap-2 font-semibold text-paper"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Try again
          </button>
        </AlertBanner>
      ) : null}
    </aside>
  );
}
