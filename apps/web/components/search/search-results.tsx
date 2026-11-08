'use client';

// The results area: scope tabs with exact counts, the result-summary row with
// the wired sort sheet, one section per returned group, stated truncation
// (never silent), and the empty state. Groups keep the fixed order Sessions,
// Tracks, Playlists.

import Link from 'next/link';
import type { ComponentType, ReactNode } from 'react';
import { Disc3, ListMusic, MicVocal, SearchX, SlidersHorizontal, Sparkles } from 'lucide-react';
import type { SearchResponseData } from '@liedmotif/shared';
import { SEARCH_SCOPED_GROUP_LIMIT } from '@liedmotif/shared';
import { cn } from '@/lib/cn';
import { homeIntentHref } from '@/components/create/intent-prefill';
import { AlertBanner, EmptyState, sectionHeadingClass } from '@/components/ui/design-system';
import { primaryButtonClass } from '@/components/ui/form-styles';
import { LoadingRow } from '@/components/ui/loading';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  isSearchScope,
  SEARCH_GROUP_LABELS,
  SEARCH_GROUPS,
  SEARCH_SORT_LABELS,
  type SearchGroupKind,
  type SearchScope,
  type SearchSort,
  type SearchState,
} from './search-model';
import {
  SearchPlaylistResults,
  SearchSessionResults,
  SearchTrackResults,
  type SearchEngagement,
} from './search-rows';
import { SearchSortSheet } from './search-sheets';
import type { SearchGroupCounts, SearchQueryState } from './use-search-query';
import { SessionGlyph } from '@/components/ui/glyphs';

const GROUP_ICONS: Record<SearchGroupKind, ComponentType<{ className?: string }>> = {
  sessions: SessionGlyph,
  tracks: Disc3,
  playlists: ListMusic,
};

export function SearchResults({
  state,
  results,
  onScopeChange,
  onSortChange,
  onEngage,
}: {
  state: SearchState;
  results: SearchQueryState;
  onScopeChange: (scope: SearchScope) => void;
  onSortChange: (sort: SearchSort) => void;
  onEngage: SearchEngagement;
}) {
  const { data, loading, error, counts } = results;

  // The branded loader appears for a FIRST query only; while a newer query is
  // in flight the previous results stay on screen instead of flashing empty.
  if (data === null) {
    if (error) return <AlertBanner className="mt-4 max-w-[760px]">{error}</AlertBanner>;
    if (loading) return <LoadingRow className="max-w-[760px] py-12" label="Searching…" />;
    return null;
  }

  const body = (
    <>
      <SummaryRow data={data} sort={state.sort} onSortChange={onSortChange} />
      {error ? <AlertBanner className="mb-3">{error}</AlertBanner> : null}
      <GroupSections data={data} onEngage={onEngage} />
    </>
  );

  if (data.lyrics) {
    // Lyrics mode collapses the scope tabs: only Tracks can match, and the
    // mode line above the results says so in words.
    return (
      <div className="max-w-[760px]" aria-live="polite">
        <p className="mt-3 inline-flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.06em] text-lamp">
          <MicVocal className="h-3.5 w-3.5" aria-hidden /> Searching lyrics · Tracks only
        </p>
        {body}
      </div>
    );
  }

  return (
    <Tabs
      value={state.scope}
      onValueChange={(scope) => isSearchScope(scope) && onScopeChange(scope)}
      className="max-w-[760px]"
    >
      <TabsList
        aria-label="Search result type"
        className="w-full justify-start gap-1 overflow-x-auto border-0 bg-transparent p-0 pb-2 pt-0.5"
      >
        <ScopeTab value="all" label="All" count={totalCount(counts)} />
        {SEARCH_GROUPS.map((group) => (
          <ScopeTab
            key={group}
            value={group}
            label={SEARCH_GROUP_LABELS[group]}
            count={counts[group]}
          />
        ))}
      </TabsList>
      <TabsContent value={state.scope} forceMount className="mt-0" aria-live="polite">
        {body}
      </TabsContent>
    </Tabs>
  );
}

/** Exact matches across every group the response carried. */
function totalMatchCount(data: SearchResponseData): number {
  return SEARCH_GROUPS.reduce((total, group) => total + (data[group]?.matchCount ?? 0), 0);
}

/** The All badge sums the three group counts — shown only once all are known. */
function totalCount(counts: SearchGroupCounts): number | null {
  let total = 0;
  for (const group of SEARCH_GROUPS) {
    const count = counts[group];
    if (count === null) return null;
    total += count;
  }
  return total;
}

function ScopeTab({
  value,
  label,
  count,
}: {
  value: SearchScope;
  label: string;
  count: number | null;
}) {
  return (
    <TabsTrigger
      value={value}
      className="min-h-[38px] flex-none basis-auto gap-2 px-3 text-[13px] data-[state=active]:bg-lamp/[0.08] data-[state=active]:text-lamp data-[state=active]:shadow-none"
    >
      {label}
      {count !== null ? (
        <span className="font-mono text-[10px] font-normal opacity-70">{count}</span>
      ) : null}
    </TabsTrigger>
  );
}

function SummaryRow({
  data,
  sort,
  onSortChange,
}: {
  data: SearchResponseData;
  sort: SearchSort;
  onSortChange: (sort: SearchSort) => void;
}) {
  const total = totalMatchCount(data);
  return (
    <div className="mb-2 mt-3 flex items-start justify-between gap-3">
      <p className="text-[13px] text-muted">
        {total === 1 ? '1 result' : `${total} results`} for{' '}
        <span className="font-semibold text-paper">“{data.query}”</span>
      </p>
      <SearchSortSheet sort={sort} onSortChange={onSortChange}>
        <button
          type="button"
          aria-label={`Sort search results: ${SEARCH_SORT_LABELS[sort]}`}
          className="inline-flex shrink-0 items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.05em] text-dim hover:text-paper"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" /> {SEARCH_SORT_LABELS[sort]}
        </button>
      </SearchSortSheet>
    </div>
  );
}

function GroupSections({
  data,
  onEngage,
}: {
  data: SearchResponseData;
  onEngage: SearchEngagement;
}) {
  const { sessions, tracks, playlists } = data;
  if (totalMatchCount(data) === 0) return <SearchEmptyState data={data} />;
  // A single-group view (a scope tab, or the lyrics lens) has no tab that
  // could widen a capped list, so its truncation must be stated in words.
  const showTruncationNote = data.scope !== 'all' || data.lyrics;
  return (
    <>
      {sessions ? (
        <GroupSection kind="sessions" group={sessions} showTruncationNote={showTruncationNote}>
          <SearchSessionResults items={sessions.items} query={data.query} onEngage={onEngage} />
        </GroupSection>
      ) : null}
      {tracks ? (
        <GroupSection kind="tracks" group={tracks} showTruncationNote={showTruncationNote}>
          <SearchTrackResults items={tracks.items} query={data.query} onEngage={onEngage} />
        </GroupSection>
      ) : null}
      {playlists ? (
        <GroupSection kind="playlists" group={playlists} showTruncationNote={showTruncationNote}>
          <SearchPlaylistResults items={playlists.items} query={data.query} onEngage={onEngage} />
        </GroupSection>
      ) : null}
    </>
  );
}

function GroupSection({
  kind,
  group,
  showTruncationNote,
  children,
}: {
  kind: SearchGroupKind;
  group: { matchCount: number; truncated: boolean };
  showTruncationNote: boolean;
  children: ReactNode;
}) {
  if (group.matchCount === 0) return null;
  const Icon = GROUP_ICONS[kind];
  return (
    <section className="mt-6 first:mt-2">
      <h2 className={`${sectionHeadingClass} mb-3 flex items-center gap-2`}>
        <Icon className="h-4 w-4 text-dim" />
        {SEARCH_GROUP_LABELS[kind]}
        <span className="ml-1 font-mono text-[10px] font-normal uppercase tracking-[0.06em] text-dim">
          {group.matchCount} {group.matchCount === 1 ? 'match' : 'matches'}
        </span>
      </h2>
      {children}
      {group.truncated && showTruncationNote ? (
        <p className="mt-3 text-[13px] text-muted">
          Showing the {SEARCH_SCOPED_GROUP_LIMIT} best matches — narrow your search.
        </p>
      ) : null}
    </section>
  );
}

function SearchEmptyState({ data }: { data: SearchResponseData }) {
  return (
    <EmptyState
      icon={<SearchX className="h-6 w-6" />}
      title={`Nothing matches “${data.query}”`}
      className="py-10"
    >
      {data.lyrics ? (
        'No captured lyrics contain that line. Instrumental Tracks have no lyrics to search.'
      ) : (
        // A search that finds nothing is often a description of music that
        // does not exist yet. The hand-off only prefills Home's create card
        // — search itself never creates and never spends.
        <span className="block">
          <span className="block">
            Music that doesn’t exist yet can be made — turn your words into a new Session.
          </span>
          <Link
            href={homeIntentHref(data.query)}
            className={cn(primaryButtonClass, 'mx-auto mt-4 w-full max-w-[320px]')}
          >
            <Sparkles className="h-4 w-4" aria-hidden /> Start a Session from “{data.query}”
          </Link>
        </span>
      )}
    </EmptyState>
  );
}
