'use client';

// Home: the create flow. Hitting Start navigates to /player IMMEDIATELY —
// the in-flight start request rides the session handoff, and the player page
// narrates the connecting state and the outcome. A Start tapped while another
// is still in flight fires nothing and only returns to that one. Home stays
// the "ask for music" surface; the live player lives on /player.

import { useEffect } from 'react';
import type { CoverStyleChoice, SurpriseProposal } from '@liedmotif/shared';
import type { SessionLanguageChoice } from '@/lib/session-languages';
import type { OwnVoiceOffer } from '@/lib/voice';
import { useAppChrome } from '@/components/app-chrome-context';
import { CreateSessionCard } from '@/components/create/create-session-card';
import { INTENT_PARAM } from '@/components/create/intent-prefill';
import { formatGreeting } from '@/components/home/home-greeting';
import { RecentSessions } from '@/components/home/recent-sessions';
import {
  useResumableSessions,
  type ResumableSessionsInitialData,
} from '@/components/sessions/use-resumable-sessions';
import { useHandOffStart } from '@/components/player/use-hand-off-start';
import { startSession, startSurprise } from '@/lib/api-client';
import { displayHeadingClass } from '@/components/ui/design-system';
import { cn } from '@/lib/cn';
import { RECENT_SESSIONS_LIMIT } from '@/lib/constants';

export function HomeView({
  greeting,
  defaultCoverStyle,
  defaultUseStandardCover,
  defaultLanguage,
  llmConfigured,
  forYouGenres,
  ownVoiceOffer = 'hidden',
  initialSessions,
  initialPrompt,
  pendingSurprise = null,
}: {
  /** This load's headline greeting template, picked on the server so the
   * rendered headline is the same one hydration finds (`{name}` slot). */
  greeting: string;
  defaultCoverStyle?: CoverStyleChoice;
  defaultUseStandardCover?: boolean;
  defaultLanguage?: SessionLanguageChoice;
  llmConfigured: boolean;
  forYouGenres: readonly string[];
  /** How "Use my voice" is offered on the create card (default: absent). */
  ownVoiceOffer?: OwnVoiceOffer;
  /** Server-rendered recent-sessions rail (skips the mount fetch). */
  initialSessions?: ResumableSessionsInitialData;
  /** The search hand-off: seeds the Describe field once, never auto-submits. */
  initialPrompt?: string;
  /** The Surprise Me proposal still pending from an earlier visit. */
  pendingSurprise?: SurpriseProposal | null;
}) {
  const { listener } = useAppChrome();
  const handOffStart = useHandOffStart();
  const resumable = useResumableSessions({
    limit: RECENT_SESSIONS_LIMIT,
    initial: initialSessions,
  });

  // The intent parameter is read once; dropping it from the URL keeps a later
  // refresh from resurrecting a stale hand-off over the user's own words.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(INTENT_PARAM)) return;
    url.searchParams.delete(INTENT_PARAM);
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  }, []);

  return (
    <div>
      <h1 className={cn(displayHeadingClass, 'mb-6 desk:mb-2')}>
        {formatGreeting(greeting, listener.name)}
      </h1>

      {/* Side by side only when the content area has room for both columns;
          narrower, the page keeps the phone's stacked order. The rail's column
          stays when the rail is absent, so the Describe field never grows wide. */}
      <div className="@container">
        <div className="@split:grid @split:grid-cols-[minmax(0,1fr)_400px] @split:items-start @split:gap-10">
          <RecentSessions state={resumable} />
          <div className="@split:col-start-1 @split:row-start-1">
            <CreateSessionCard
              llmConfigured={llmConfigured}
              forYouGenres={forYouGenres}
              ownVoiceOffer={ownVoiceOffer}
              surprise={{
                pending: pendingSurprise,
                onStart: (request) => handOffStart((signal) => startSurprise(request, signal)),
              }}
              {...(initialPrompt ? { initialPrompt } : {})}
              onStart={(request) => handOffStart((signal) => startSession(request, signal))}
              {...(defaultCoverStyle ? { defaultCoverStyle } : {})}
              {...(defaultUseStandardCover !== undefined ? { defaultUseStandardCover } : {})}
              {...(defaultLanguage ? { defaultLanguage } : {})}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
