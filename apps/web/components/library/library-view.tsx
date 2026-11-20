'use client';

import { useRef, useState } from 'react';
import type { LibraryTrackItem, TrackFlags } from '@liedmotif/shared';
import { Sheet } from '@/components/ui/sheet';
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
import { useLibraryQuery, type LibraryTab, type LibraryTrackTab } from './use-library-query';
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
  return <LibrarySmartListView key={view} view={view} onChange={setView} />;
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
  view: LibraryTrackTab;
  onChange: (view: LibraryTab) => void;
}) {
  const [search, setSearch] = useState('');
  const query = useLibraryQuery(view, search);
  const [selected, setSelected] = useState<LibraryTrackItem | null>(null);
  const [pickerTrack, setPickerTrack] = useState<SavePickerTrack | null>(null);
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
  const playback = useTrackRowPlayback('library-play');

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
        />
      </div>

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
