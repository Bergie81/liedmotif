import Link from 'next/link';
import type { LibraryTrackItem } from '@liedmotif/shared';
import { Disc3 } from 'lucide-react';
import { AlertBanner, EmptyState } from '@/components/ui/design-system';
import { primaryButtonClass } from '@/components/ui/form-styles';
import { LoadMoreButton } from '@/components/ui/load-more-button';
import { LoadingRow } from '@/components/ui/loading';
import { libraryTabLabel } from './library-navigation';
import { formatLibraryTrackMetadata, getTrackAvailability } from './library-view-model';
import { TrackRow, type PreviewState, type TrackRowBadge } from './track-row';
import type { LibraryTrackTab } from './use-library-query';

export function LibraryTrackList({
  view,
  searchQuery = '',
  items,
  nextCursor,
  error,
  loadingMore,
  busyTrackId,
  preview,
  onPreview,
  onOptions,
  onLoadMore,
}: {
  view: LibraryTrackTab;
  /** The active search; a no-result page renders "no matches", not the tab's empty state. */
  searchQuery?: string;
  items: LibraryTrackItem[] | null;
  nextCursor: string | null;
  error: string | null;
  loadingMore: boolean;
  busyTrackId: string | null;
  preview: { trackId: string | null; state: PreviewState };
  onPreview: (track: LibraryTrackItem) => void;
  onOptions: (track: LibraryTrackItem, opener: HTMLButtonElement) => void;
  onLoadMore: () => void;
}) {
  if (error && !items) return <LibraryError message={error} />;
  if (items === null) {
    return <LoadingRow className="py-12" label={`Loading ${libraryTabLabel(view)}…`} />;
  }
  if (items.length === 0) {
    if (searchQuery) return <LibraryNoMatches query={searchQuery} />;
    return <LibraryEmpty view={view} />;
  }

  return (
    <>
      <div className="mt-3 @container">
        <section
          className="@pair:grid @pair:grid-cols-[repeat(2,1fr)] @pair:content-start @pair:gap-x-14"
          data-testid="library-list"
        >
          {items.map((track) => {
            const availability = getTrackAvailability(track);
            const badges: TrackRowBadge[] = [];
            if (view === 'history' && !availability.hasPlayed)
              badges.push({ label: 'Never Played' });
            if (availability.audioNotice) badges.push({ label: availability.audioNotice });
            return (
              <TrackRow
                key={track.id}
                track={track}
                metadata={formatLibraryTrackMetadata(track)}
                badges={badges}
                minimalCoverRounding
                previewState={preview.trackId === track.id ? preview.state : 'idle'}
                busy={busyTrackId !== null}
                onPreview={() => onPreview(track)}
                onOptions={(opener) => onOptions(track, opener)}
              />
            );
          })}
          {nextCursor ? (
            <LoadMoreButton
              loading={loadingMore}
              onClick={onLoadMore}
              className="mt-4 @pair:col-span-full"
            />
          ) : null}
          {error ? <LibraryError message={error} /> : null}
        </section>
      </div>
    </>
  );
}

export function LibraryError({ message }: { message: string }) {
  return <AlertBanner className="my-3 @pair:col-span-full">{message}</AlertBanner>;
}

function LibraryNoMatches({ query }: { query: string }) {
  return (
    <EmptyState icon={<Disc3 className="h-6 w-6" />} title="No Matches" className="mt-4">
      Nothing here matches “{query}”. Try a track or session title, or a genre.
    </EmptyState>
  );
}

function LibraryEmpty({ view }: { view: LibraryTrackTab }) {
  const copy = {
    saved: ['No Saved Tracks Yet', 'Save a track during a session and it will wait here.'],
    history: ['No History Yet', 'Every generated track appears here, even if it was never played.'],
  } as const;
  return (
    <EmptyState
      icon={<Disc3 className="h-6 w-6" />}
      title={copy[view][0]}
      className="mt-4"
      action={
        <Link href="/" className={primaryButtonClass}>
          Start a Session
        </Link>
      }
    >
      {copy[view][1]}
    </EmptyState>
  );
}
