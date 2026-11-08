'use client';

import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  SEARCH_SCOPED_GROUP_LIMIT,
  type ActiveSessionOverview,
  type SearchSessionItem,
  type SessionListItem,
  type SessionSummary,
} from '@liedmotif/shared';
import { Disc3, MoreVertical, RotateCcw, SearchX } from 'lucide-react';
import { LibrarySearchField } from '@/components/library/library-search-field';
import { MatchContextLine } from '@/components/search/match-context';
import {
  AlertBanner,
  cardClass,
  EmptyState,
  iconButtonClass,
  sectionHeadingClass,
} from '@/components/ui/design-system';
import { primaryButtonClass } from '@/components/ui/form-styles';
import { LoadMoreButton } from '@/components/ui/load-more-button';
import { LoadingRow } from '@/components/ui/loading';
import { cn } from '@/lib/cn';
import { MOBILE_EARLIER_SESSIONS_LIMIT } from '@/lib/constants';
import {
  usePlayerActions,
  usePlayerContext,
  type EngagedSource,
} from '@/components/player/player-provider';
import { SessionCard, SessionCardLastActiveDetails } from './session-card';
import { deriveSessionsListView, formatSessionTrackLine } from './session-list-model';
import { SessionOptionsFlow } from './session-options-flow';
import { SessionTracksProvider } from './session-tracks-sheet';
import { useResumableSessions, type ResumableSessionsInitialData } from './use-resumable-sessions';
import { useSessionSearch, type SessionSearch } from './use-session-search';

/** One card grid for every section, so the active, Pinned and History cards share a width. */
const sessionGridClass = 'grid gap-2 desk:gap-3 @pair:grid-cols-2';

export function MySessionsList({
  initial,
}: {
  /** Server-rendered first page (the page shell fetches it with the render). */
  initial?: ResumableSessionsInitialData;
} = {}) {
  // Read the volatile playback state HERE and hand the list only stable
  // projections of it, so the memo boundary below stops the controller's 1–4 Hz
  // state churn from re-rendering the whole card grid.
  const { playback, engagedSource } = usePlayerContext();
  return (
    <SessionTracksProvider>
      <MySessionsListContent
        initial={initial}
        liveSession={playback?.session ?? null}
        liveCoverImageId={playback?.player.sessionCoverImageId ?? null}
        engagedSource={engagedSource}
      />
    </SessionTracksProvider>
  );
}

const MySessionsListContent = memo(function MySessionsListContent({
  initial,
  liveSession,
  liveCoverImageId,
  engagedSource,
}: {
  initial?: ResumableSessionsInitialData;
  liveSession: SessionSummary | null;
  liveCoverImageId: string | null;
  engagedSource: EngagedSource | null;
}) {
  const list = useResumableSessions({ includeActive: true, includePinned: true, initial });
  const {
    activeSession,
    items,
    error,
    nextCursor,
    loadingMore,
    loadMore,
    setOperationError,
    pinned,
    retry,
  } = list;
  const { engage, beginOtherMusic } = usePlayerActions();
  const [selected, setSelected] = useState<SessionListItem | null>(null);
  const [query, setQuery] = useState('');
  const sessionSearch = useSessionSearch(query);
  const optionsOpenerRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const {
    active,
    pinned: pinnedSessions,
    earlier,
  } = deriveSessionsListView({
    serverActive: activeSession,
    liveSession,
    liveCoverImageId,
    items,
    pinned,
  });
  // Playing a Session found through search leaves no list row to read its Track
  // activity from, so the Active now card asks the server.
  const liveSessionId = liveSession?.id ?? null;
  const liveSessionKnown =
    liveSessionId === null ||
    activeSession?.id === liveSessionId ||
    [...(items ?? []), ...pinned].some((item) => item.id === liveSessionId);
  useEffect(() => {
    if (!liveSessionKnown) retry();
    // Runs once per unknown Session: a reload that still doesn't name it changes neither dep.
  }, [liveSessionId, liveSessionKnown]);
  const earlierSessions = earlier ?? [];
  const hasPinnedSessions = pinnedSessions.length > 0;
  const hasEarlierSessions = earlierSessions.length > 0;
  const hasAnySessions = Boolean(active) || hasPinnedSessions || hasEarlierSessions;
  // /player renders whatever source is engaged, so the Active now card may link
  // there only while that source IS this Session (or nothing is engaged yet).
  // Under another source — a Playlist — the card switches playback back in
  // place instead: the provider hands off audibly when the other source is
  // playing, quietly otherwise.
  const playerRouteShowsActive =
    active !== null &&
    (engagedSource === null ||
      (engagedSource.kind === 'session' && engagedSource.session.id === active.id));

  async function switchPlaybackToActive(session: SessionSummary) {
    if (!(await beginOtherMusic())) return;
    engage(session, { autoplay: false });
  }

  function closeOptions() {
    setSelected(null);
    requestAnimationFrame(() => {
      const focusTarget = optionsOpenerRef.current?.isConnected
        ? optionsOpenerRef.current
        : contentRef.current;
      focusTarget?.focus();
      optionsOpenerRef.current = null;
    });
  }

  function renderStoppedCard(
    session: SessionListItem,
    index: number,
    { details, className }: { details?: ReactNode; className?: string } = {},
  ) {
    const title = session.title ?? 'Untitled Session';
    return (
      <SessionCard
        sessionId={session.id}
        trackCount={session.trackCount}
        key={session.id}
        title={session.title}
        coverImageId={session.coverImageId}
        genreTags={session.genreTags}
        activityFallback="Ready to continue"
        coverVariant={index}
        className={className}
        details={
          details ?? (
            <SessionCardLastActiveDetails
              trackCount={session.trackCount}
              totalDurationSeconds={session.totalDurationSeconds}
              lastActiveAt={session.lastActiveAt}
            />
          )
        }
        action={
          <button
            type="button"
            className={iconButtonClass}
            onClick={(event) => {
              optionsOpenerRef.current = event.currentTarget;
              setSelected(session);
              setOperationError(null);
            }}
            aria-label={`Options for ${title}`}
          >
            <MoreVertical className="h-[19px] w-[19px]" aria-hidden />
          </button>
        }
      />
    );
  }

  function renderActiveCard(session: ActiveSessionOverview, details?: ReactNode) {
    return (
      <SessionCard
        sessionId={session.id}
        trackCount={session.trackCount}
        key={session.id}
        active
        {...(playerRouteShowsActive
          ? { href: '/player' }
          : { onClick: () => void switchPlaybackToActive(session) })}
        title={session.title}
        coverImageId={session.coverImageId}
        genreTags={session.genreTags}
        activityFallback="Ready to make music"
        details={
          details ?? formatSessionTrackLine(session.trackCount, session.totalDurationSeconds)
        }
      />
    );
  }

  return (
    <>
      <div ref={contentRef} tabIndex={-1} className="@container">
        {query || hasAnySessions ? (
          // No top margin: the @container keeps it from collapsing into the page's gap.
          <LibrarySearchField
            className="mb-6"
            placeholder="Search sessions by name, track or genre"
            onSearch={setQuery}
          />
        ) : null}

        {sessionSearch.searching ? (
          <SessionSearchResults
            search={sessionSearch}
            renderCard={(result, index, details) =>
              result.id === active?.id
                ? renderActiveCard(active, details)
                : renderStoppedCard(result, index, { details })
            }
          />
        ) : (
          <>
            {active ? (
              <section aria-labelledby="active-session-heading">
                <h2 id="active-session-heading" className={cn(sectionHeadingClass, 'mb-3')}>
                  Active now
                </h2>
                <div className={sessionGridClass}>{renderActiveCard(active)}</div>
              </section>
            ) : null}

            {items === null && error === null ? (
              <LoadingRow
                className={cn(cardClass, 'py-12', active && 'mt-6')}
                label="Loading Sessions…"
              />
            ) : null}

            {items !== null && !hasAnySessions && !error ? <NoSessionsYet /> : null}

            {hasPinnedSessions ? (
              <section aria-labelledby="pinned-sessions-heading">
                <h2
                  id="pinned-sessions-heading"
                  className={cn(sectionHeadingClass, 'mb-3', active && 'mt-6')}
                >
                  Pinned
                </h2>
                <div className={sessionGridClass}>
                  {pinnedSessions.map((session, index) => renderStoppedCard(session, index))}
                </div>
              </section>
            ) : null}

            {hasEarlierSessions ? (
              <section aria-labelledby="earlier-sessions-heading">
                <h2
                  id="earlier-sessions-heading"
                  className={cn(
                    sectionHeadingClass,
                    'mb-3',
                    (active || hasPinnedSessions) && 'mt-6',
                  )}
                >
                  History
                </h2>
                <div data-testid="my-sessions-list" className={sessionGridClass}>
                  {/* Continue the cover-variant sequence so placeholders alternate across sections. */}
                  {earlierSessions.map((session, index) =>
                    renderStoppedCard(session, pinnedSessions.length + index, {
                      className:
                        index >= MOBILE_EARLIER_SESSIONS_LIMIT ? 'max-desk:hidden' : undefined,
                    }),
                  )}
                </div>
                {nextCursor ? (
                  <LoadMoreButton
                    loading={loadingMore}
                    onClick={() => void loadMore()}
                    className={cn(
                      'mt-4',
                      earlierSessions.length >= MOBILE_EARLIER_SESSIONS_LIMIT && 'max-desk:hidden',
                    )}
                  />
                ) : null}
              </section>
            ) : null}
          </>
        )}

        {error && !selected ? (
          <AlertBanner className="mt-4">
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
      </div>

      <SessionOptionsFlow
        selected={selected}
        onClose={closeOptions}
        list={list}
        search={sessionSearch}
      />
    </>
  );
});

function SessionSearchResults({
  search,
  renderCard,
}: {
  search: SessionSearch;
  renderCard: (result: SearchSessionItem, index: number, details: ReactNode) => ReactNode;
}) {
  return (
    <section aria-label="Session search results">
      {search.error ? <AlertBanner>{search.error}</AlertBanner> : null}
      {search.results === null && !search.error ? (
        <LoadingRow className={cn(cardClass, 'py-12')} label="Searching Sessions…" />
      ) : null}
      {search.results?.length === 0 ? (
        <EmptyState
          icon={<SearchX className="h-6 w-6" />}
          title={`No Sessions match “${search.resultsQuery}”`}
          className="py-10"
        >
          Search looks at Session names, Track titles, genres and prompts.
        </EmptyState>
      ) : null}
      <div className={sessionGridClass}>
        {search.results?.map((result, index) =>
          renderCard(
            result,
            index,
            <MatchContextLine context={result.matchContext} query={search.resultsQuery} />,
          ),
        )}
      </div>
      {search.truncated ? (
        <p className="mt-3 text-[13px] text-muted">
          Showing the {SEARCH_SCOPED_GROUP_LIMIT} best of {search.matchCount} matches — narrow your
          search.
        </p>
      ) : null}
    </section>
  );
}

function NoSessionsYet() {
  return (
    <div className="mx-auto max-w-[460px] px-5 py-12 text-center">
      <div className="relative mx-auto mb-4 grid h-[84px] w-[84px] place-items-center overflow-hidden rounded-[10px] bg-panel-2 opacity-55 [background:radial-gradient(120%_120%_at_20%_10%,#3b2f63,#14101f_70%)] after:absolute after:inset-0 after:bg-[repeating-linear-gradient(0deg,rgba(255,255,255,0.035)_0_1px,transparent_1px_3px)] after:mix-blend-overlay after:content-['']">
        <Disc3 className="h-7 w-7 text-paper/55" aria-hidden />
      </div>
      <h2 className="mb-2 font-display text-[19px] font-bold">No Sessions yet</h2>
      <p className="mx-auto mb-5 text-[14.5px] text-muted">
        Describe what the music is for, and your first Session appears here — ready to resume any
        time.
      </p>
      <Link href="/" className={cn(primaryButtonClass, 'mx-auto w-full max-w-[260px]')}>
        Start your first Session
      </Link>
    </div>
  );
}
