import Link from 'next/link';
import type { LibraryTrackItem, LibraryView } from '@liedmotif/shared';
import { CheckSquare, Disc3, Square } from 'lucide-react';
import { AlertBanner, EmptyState } from '@/components/ui/design-system';
import { primaryButtonClass } from '@/components/ui/form-styles';
import { LoadMoreButton } from '@/components/ui/load-more-button';
import { LoadingRow } from '@/components/ui/loading';
import { libraryTabLabel } from './library-navigation';
import { formatLibraryTrackMetadata, getTrackAvailability } from './library-view-model';
import { TrackRow, type PreviewState, type TrackRowBadge } from './track-row';

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
  selection,
}: {
  view: LibraryView;
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
  /** Multi-select mode (add-to-playlist): rows toggle instead of previewing. */
  selection?: { ids: ReadonlySet<string>; onToggle: (trackId: string) => void };
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
      <div className="@container">
        <section
          className="@pair:grid @pair:grid-cols-[repeat(2,1fr)] @pair:content-start @pair:gap-x-14"
          data-testid="library-list"
        >
          {items.map((track) => {
            const availability = getTrackAvailability(track);
            const badges: TrackRowBadge[] = [];
            if (view === 'history' && !availability.hasPlayed)
              badges.push({ label: 'Never played' });
            if (!availability.hasAudio) badges.push({ label: 'Audio unavailable' });
            if (selection) {
              const isSelected = selection.ids.has(track.id);
              return (
                <TrackRow
                  key={track.id}
                  track={track}
                  metadata={formatLibraryTrackMetadata(track)}
                  badges={badges}
                  minimalCoverRounding
                  previewState="idle"
                  busy={false}
                  onPreview={() => selection.onToggle(track.id)}
                  onOptions={() => selection.onToggle(track.id)}
                  optionsLabel={isSelected ? 'Deselect track' : 'Select track'}
                  optionsIcon={
                    isSelected ? (
                      <CheckSquare className="h-[19px] w-[19px] text-lamp" />
                    ) : (
                      <Square className="h-[19px] w-[19px]" />
                    )
                  }
                />
              );
            }
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
          <LibraryFooter view={view} />
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
    <EmptyState icon={<Disc3 className="h-6 w-6" />} title="No matches" className="mt-4">
      Nothing here matches “{query}”. Try a Track or Session title, or a genre.
    </EmptyState>
  );
}

function LibraryEmpty({ view }: { view: LibraryView }) {
  const copy = {
    saved: ['No Saved Tracks yet', 'Save a Track during a Session and it will wait here.'],
    favorites: ['No Favorites yet', 'Star a Saved Track to make it a Favorite.'],
    history: ['No History yet', 'Every generated Track appears here, even if it was never played.'],
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

function LibraryFooter({ view }: { view: LibraryView }) {
  const copy =
    view === 'saved'
      ? 'Every Track in your Playlists · kept when you delete its Session'
      : view === 'history'
        ? 'Every generated Track lands here'
        : null;
  if (!copy) return null;
  return (
    <p className="mt-4 font-mono text-[10.5px] uppercase leading-[1.7] tracking-[0.05em] text-dim @pair:col-span-full">
      {copy}
    </p>
  );
}
