'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  LibraryTrackItem,
  LibraryView as LibrarySmartList,
  TrackFlags,
} from '@liedmotif/shared';
import { CheckSquare } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { addPlaylistTracks, listPlaylists } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';
import { AlertBanner } from '@/components/ui/design-system';
import { secondaryButtonClass } from '@/components/ui/form-styles';
import { LoadingRow } from '@/components/ui/loading';
import { OnlineOnly } from '@/components/ui/online-only';
import { Sheet } from '@/components/ui/sheet';
import { ChoosePlaylistSheet } from '@/components/playlists/choose-playlist-sheet';
import { PlaylistDetail } from '@/components/playlists/playlist-detail';
import { PlaylistsGrid, type PlaylistsFirstPage } from '@/components/playlists/playlists-grid';
import {
  SaveToPlaylistSheet,
  type SavePickerTrack,
} from '@/components/playlists/save-to-playlist-sheet';
import { LibraryNavigation } from './library-navigation';
import { LibrarySearchField } from './library-search-field';
import { withSettledRetention } from './library-view-model';
import { LibraryTrackList } from './library-track-list';
import { TrackOptionsSheet } from './track-options-sheet';
import { useLibraryActions } from './use-library-actions';
import { useLibraryQuery, type LibraryTab } from './use-library-query';
import { useTrackRowPlayback } from './use-track-row-playback';

export function LibraryView({
  initialPlaylists,
}: {
  /** Server-rendered first playlists page for the default tab (skips the mount fetch). */
  initialPlaylists?: PlaylistsFirstPage;
} = {}) {
  const [view, setView] = useState<LibraryTab>('playlists');
  // The server data seeds the FIRST playlists render only. Leaving the tab
  // spends it: other tabs can mutate memberships, so a return must refetch
  // (the grid remounts per visit and would otherwise re-seed stale data).
  const initialPlaylistsRef = useRef(initialPlaylists);
  if (view !== 'playlists') initialPlaylistsRef.current = undefined;
  if (view === 'playlists') {
    return (
      <PlaylistsView
        view={view}
        onChange={setView}
        initialPlaylists={initialPlaylistsRef.current}
      />
    );
  }
  if (view === 'favorites') {
    // Favorites IS the Favorites system Playlist: the tab shows it
    // in the owner's order, reorderable — not a flag-sorted smart list.
    return <FavoritesPlaylistView view={view} onChange={setView} />;
  }
  return <LibrarySmartListView key={view} view={view} onChange={setView} />;
}

function FavoritesPlaylistView({
  view,
  onChange,
}: {
  view: LibraryTab;
  onChange: (view: LibraryTab) => void;
}) {
  const [favoritesId, setFavoritesId] = useState<string | null>(null);
  const [trackCount, setTrackCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void listPlaylists().then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError(`Couldn’t load Favorites: ${result.error.message}`);
        return;
      }
      const favorites = result.data.playlists.find((p) => p.kind === 'favorites');
      setFavoritesId(favorites?.id ?? null);
      setTrackCount(favorites?.trackCount ?? 0);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // One wrapper so the app shell's `space-y-6` treats the whole tab as a single
  // child — inner spacing stays the tabs' own `mt-*` rhythm on every tab.
  return (
    <div>
      <LibraryNavigation
        view={view}
        currentCount={trackCount}
        hasMore={false}
        onChange={onChange}
      />
      {error ? (
        <AlertBanner className="mt-4">{error}</AlertBanner>
      ) : favoritesId ? (
        <div className="mt-4 max-w-[760px]">
          <PlaylistDetail playlistId={favoritesId} onTrackCountChange={setTrackCount} />
        </div>
      ) : (
        <LoadingRow className="mt-6 py-8" label="Loading Favorites…" />
      )}
    </div>
  );
}

function PlaylistsView({
  view,
  onChange,
  initialPlaylists,
}: {
  view: LibraryTab;
  onChange: (view: LibraryTab) => void;
  initialPlaylists?: PlaylistsFirstPage;
}) {
  const [tabCount, setTabCount] = useState<{ shown: number; hasMore: boolean } | null>(null);
  // One wrapper so the app shell's `space-y-6` never reaches into the tab.
  return (
    <div>
      <LibraryNavigation
        view={view}
        currentCount={tabCount?.shown ?? null}
        hasMore={tabCount?.hasMore ?? false}
        onChange={onChange}
      />
      <PlaylistsGrid
        onCountChange={(shown, hasMore) => setTabCount({ shown, hasMore })}
        initialPlaylists={initialPlaylists}
      />
    </div>
  );
}

function LibrarySmartListView({
  view,
  onChange,
}: {
  view: LibrarySmartList;
  onChange: (view: LibraryTab) => void;
}) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const query = useLibraryQuery(view, search);
  const [selected, setSelected] = useState<LibraryTrackItem | null>(null);
  const [pickerTrack, setPickerTrack] = useState<SavePickerTrack | null>(null);
  // Multi-select add-to-playlist (a track-level action with
  // multi-select): rows toggle membership in the pending set, then one commit
  // into a chosen playlist.
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [choosingPlaylist, setChoosingPlaylist] = useState(false);

  function exitSelectMode() {
    setSelecting(false);
    setSelectedIds(new Set());
    setChoosingPlaylist(false);
  }

  async function addSelectionTo(playlistId: string) {
    const result = await addPlaylistTracks(playlistId, [...selectedIds]);
    if (result.ok) {
      router.refresh();
      query.reload();
      exitSelectMode();
    }
    return result;
  }
  const optionsOpenerRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  function closeOptions() {
    setSelected(null);
    requestAnimationFrame(() => {
      const target = optionsOpenerRef.current?.isConnected
        ? optionsOpenerRef.current
        : contentRef.current;
      target?.focus();
      optionsOpenerRef.current = null;
    });
  }

  function resolveFlags(
    trackId: string,
    flags: TrackFlags,
    inCuratedPlaylist: boolean,
    remove: boolean,
  ) {
    query.applyTrackFlags(trackId, flags, inCuratedPlaylist, remove);
    setSelected((track) =>
      track?.id === trackId ? withSettledRetention(track, flags, inCuratedPlaylist) : track,
    );
    if (remove) closeOptions();
  }

  const actions = useLibraryActions({
    view,
    onFlagsResolved: resolveFlags,
    onTrackRemoved: query.removeTrack,
  });
  const playback = useTrackRowPlayback(toast.error);

  return (
    <Sheet
      open={selected !== null}
      onOpenChange={(open) => !open && !actions.busyAction && closeOptions()}
    >
      <div ref={contentRef} tabIndex={-1}>
        <LibraryNavigation
          view={view}
          currentCount={query.items?.length ?? null}
          hasMore={query.nextCursor !== null}
          disabled={actions.busyAction !== null}
          onChange={onChange}
        />
        <LibrarySearchField
          placeholder="Search titles, prompts, genres, moods…"
          onSearch={setSearch}
        />
        <div className="mt-3 flex items-center justify-end gap-2">
          {selecting && selectedIds.size > 0 ? (
            <OnlineOnly>
              <button
                type="button"
                data-testid="library-add-selected"
                className={secondaryButtonClass}
                onClick={() => setChoosingPlaylist(true)}
              >
                Add {selectedIds.size} to playlist
              </button>
            </OnlineOnly>
          ) : null}
          <button
            type="button"
            data-testid="library-select-toggle"
            aria-pressed={selecting}
            className={cn(secondaryButtonClass, selecting && 'text-lamp')}
            onClick={() => (selecting ? exitSelectMode() : setSelecting(true))}
          >
            <CheckSquare className="h-4 w-4" /> {selecting ? 'Done' : 'Select'}
          </button>
        </div>
        <LibraryTrackList
          view={view}
          searchQuery={search}
          items={query.items}
          nextCursor={query.nextCursor}
          error={query.error}
          loadingMore={query.loadingMore}
          busyTrackId={actions.busyAction?.trackId ?? playback.busyTrackId}
          preview={playback.rowPreview}
          onPreview={playback.playRow}
          onOptions={(track, opener) => {
            optionsOpenerRef.current = opener;
            setSelected(track);
          }}
          onLoadMore={() => void query.loadMore()}
          selection={
            selecting
              ? {
                  ids: selectedIds,
                  onToggle: (trackId) =>
                    setSelectedIds((current) => {
                      const next = new Set(current);
                      if (next.has(trackId)) next.delete(trackId);
                      else next.add(trackId);
                      return next;
                    }),
                }
              : undefined
          }
        />
      </div>

      <ChoosePlaylistSheet
        open={choosingPlaylist}
        trackCount={selectedIds.size}
        onClose={() => setChoosingPlaylist(false)}
        onChoose={addSelectionTo}
      />

      {selected ? (
        <TrackOptionsSheet
          track={selected}
          busyAction={
            actions.busyAction?.trackId === selected.id ? actions.busyAction.action : null
          }
          onPlay={() => {
            playback.playRow(selected);
            closeOptions();
          }}
          onUnsave={() => void actions.unsave(selected)}
          onOpenSavePicker={() =>
            setPickerTrack({
              id: selected.id,
              title: selected.title,
              savedAt: selected.savedAt,
              coverImageId: selected.coverImageId,
            })
          }
          onToggleFavorite={() => void actions.toggleFavorite(selected)}
          onMoreLikeThis={() => void actions.seedMoreLikeThis(selected)}
          onDelete={async () => {
            if (await actions.deleteTrack(selected)) closeOptions();
          }}
        />
      ) : null}

      <SaveToPlaylistSheet
        track={pickerTrack}
        onClose={() => setPickerTrack(null)}
        onApplied={(data) =>
          actions.applyPickerFlags(data.trackId, data.flags, data.inCuratedPlaylist)
        }
      />

      <audio ref={playback.audioRef} data-testid="library-audio" hidden {...playback.audioEvents} />
    </Sheet>
  );
}
