'use client';

// The Library's Playlists tab: a search field over the owner's hand-picked
// playlists, a dashed "New playlist" tile, and one card per playlist whose menu
// carries the lifecycle (play, add tracks, cover, rename, delete). A card opens
// the detail page for curation. Every dialog a menu row opens is owned by the
// grid, so one `action` at a time can be in flight and no card holds mutation
// state of its own.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  isCuratedPlaylist,
  MAX_PLAYLIST_NAME_LENGTH,
  type PlaylistMemberItem,
  type PlaylistSummaryItem,
} from '@liedmotif/shared';
import {
  Armchair,
  Download,
  EllipsisVertical,
  ImageIcon,
  ListMusic,
  Pencil,
  Pin,
  Play,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  createPlaylist,
  deletePlaylist,
  getAllPlaylistMembers,
  listPlaylists,
  pinLibraryPlaylist,
  renamePlaylist,
} from '@/lib/api-client';
import { appendUniqueById } from '@/lib/append-unique';
import { cn } from '@/lib/cn';
import { playlistDownloadUrl, startFileDownload } from '@/lib/downloads';
import { usePageEpoch } from '@/components/use-page-epoch';
import { useServerSeed } from '@/components/use-server-seed';
import {
  AlertBanner,
  cardClass,
  EmptyState,
  menuTriggerClass,
} from '@/components/ui/design-system';
import { MenuRow } from '@/components/ui/menu-row';
import { OnlineOnly } from '@/components/ui/online-only';
import { RenameDialog } from '@/components/rename-dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { LibrarySearchField } from '@/components/library/library-search-field';
import { Sheet, SheetTrigger } from '@/components/ui/sheet';
import { LoadMoreButton } from '@/components/ui/load-more-button';
import { LoadingRow } from '@/components/ui/loading';
import { RelativeTime } from '@/components/relative-time';
import { OfflineMark } from '@/components/offline/offline-mark';
import { AddTracksSheet } from './add-tracks-sheet';
import {
  PlaylistCardShell,
  playlistCardMetaLineClass,
  playlistCardPinFlagClass,
} from './playlist-card-shell';
import { PlaylistCoverSheet } from './playlist-cover-sheet';
import { PlaylistOptionsSheetContent } from './playlist-options-sheet-content';
import { SharePlaylistSheet } from './share-playlist-sheet';
import {
  canDownloadPlaylist,
  deletePlaylistConfirmBody,
  formatPlaylistCardMeta,
  pinToggleFailure,
} from './playlist-view-model';
import { MENU_COPY } from '@/components/ui/menu-copy';
import { usePlayPlaylist } from './use-play-playlist';

type PlaylistGridAction =
  | { kind: 'create' }
  | { kind: 'rename'; playlist: PlaylistSummaryItem }
  | { kind: 'delete'; playlist: PlaylistSummaryItem }
  | { kind: 'add-tracks'; playlist: PlaylistSummaryItem; memberIds: string[] }
  | { kind: 'cover'; playlist: PlaylistSummaryItem }
  | { kind: 'share'; playlist: PlaylistSummaryItem };

/** What a card's menu can start — the grid owns whatever each one opens. */
export interface PlaylistCardActions {
  onPlay: (playlist: PlaylistSummaryItem) => void;
  onAddTracks: (playlist: PlaylistSummaryItem) => void;
  onManageCover: (playlist: PlaylistSummaryItem) => void;
  onRename: (playlist: PlaylistSummaryItem) => void;
  onDelete: (playlist: PlaylistSummaryItem) => void;
  /** Open the Lounge share picker — who the playlist reaches, or Private. */
  onShare: (playlist: PlaylistSummaryItem) => void;
  /** Pin it first in this list, or take it back out. */
  onTogglePin: (playlist: PlaylistSummaryItem) => void;
}

/** Server-rendered first page of the grid (the Library page's render). */
export interface PlaylistsFirstPage {
  playlists: PlaylistSummaryItem[];
  nextCursor: string | null;
}

export function PlaylistsGrid({
  onCountChange,
  initialPlaylists,
}: {
  /** Reports how many playlists the grid shows (the Library tab count) and
   * whether more pages remain (the count's trailing `+`). */
  onCountChange?: (count: number, hasMore: boolean) => void;
  /** Server-rendered first page: skips the mount fetch. Search changes
   * and mutations always reload over the API. */
  initialPlaylists?: PlaylistsFirstPage;
} = {}) {
  const [playlists, setPlaylists] = useState<PlaylistSummaryItem[] | null>(
    initialPlaylists?.playlists ?? null,
  );
  const [nextCursor, setNextCursor] = useState<string | null>(initialPlaylists?.nextCursor ?? null);
  const [search, setSearch] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [action, setAction] = useState<PlaylistGridAction | null>(null);
  const router = useRouter();
  const playback = usePlayPlaylist(setActionError);
  const consumeServerSeed = useServerSeed(initialPlaylists != null);
  const { loadingMore, beginFirstPage, beginNextPage, settle } = usePageEpoch();
  // One curated projection for both the tab count and the rendered grid.
  const curatedPlaylists = useMemo(() => playlists?.filter(isCuratedPlaylist) ?? null, [playlists]);

  // A failed load keeps whatever the grid shows, and the search field that can retry it.
  const load = useCallback(async () => {
    const token = beginFirstPage();
    const result = await listPlaylists({ search });
    if (!settle(token)) return;
    if (!result.ok) {
      setActionError(`Couldn’t load playlists: ${result.error.message}`);
      return;
    }
    setActionError(null);
    setPlaylists(result.data.playlists);
    setNextCursor(result.data.nextCursor);
  }, [search, beginFirstPage, settle]);
  // A pin can land after the search changed; its reload must use the current one.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (consumeServerSeed()) return;
    void load();
  }, [load, consumeServerSeed]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const token = beginNextPage();
    if (token === null) return;
    setActionError(null);
    const result = await listPlaylists({ search, cursor: nextCursor });
    if (!settle(token)) return;
    if (!result.ok) {
      setActionError(`Couldn’t load more playlists: ${result.error.message}`);
      return;
    }
    // An activity-ordered keyset can hand back a playlist that moved while
    // paging — append id-unique so a card never renders twice.
    setPlaylists((current) => appendUniqueById(current ?? [], result.data.playlists));
    setNextCursor(result.data.nextCursor);
  }

  // Report only on a real change: the effect is keyed on `onCountChange`, so
  // without this bail-out an inline callback plus a per-call state object
  // would spin effect → state → render → effect forever.
  const lastReportedCount = useRef<{ shown: number; hasMore: boolean } | null>(null);
  useEffect(() => {
    if (!curatedPlaylists) return;
    const shown = curatedPlaylists.length;
    const hasMore = nextCursor !== null;
    const last = lastReportedCount.current;
    if (last && last.shown === shown && last.hasMore === hasMore) return;
    lastReportedCount.current = { shown, hasMore };
    onCountChange?.(shown, hasMore);
  }, [curatedPlaylists, nextCursor, onCountChange]);

  async function create(name: string): Promise<string | null> {
    const result = await createPlaylist(name);
    if (!result.ok) return result.error.message;
    router.push(`/library/playlist/${result.data.playlist.id}`);
    return null;
  }

  async function loadMembers(playlist: PlaylistSummaryItem): Promise<PlaylistMemberItem[] | null> {
    const result = await getAllPlaylistMembers(playlist.id);
    if (!result.ok) {
      setActionError(`Couldn’t load the playlist: ${result.error.message}`);
      return null;
    }
    return result.data.items;
  }

  async function playPlaylist(playlist: PlaylistSummaryItem) {
    const items = await loadMembers(playlist);
    if (items) playback.play(playlist, items);
  }

  async function startAddTracks(playlist: PlaylistSummaryItem) {
    const items = await loadMembers(playlist);
    if (items) {
      setAction({ kind: 'add-tracks', playlist, memberIds: items.map((item) => item.id) });
    }
  }

  async function applyRename(playlist: PlaylistSummaryItem, name: string): Promise<string | null> {
    const result = await renamePlaylist(playlist.id, name);
    if (!result.ok) return result.error.message;
    setPlaylists((all) => all?.map((p) => (p.id === playlist.id ? { ...p, name } : p)) ?? all);
    return null;
  }

  /** A pin decides the card's place, so the list reloads from the server's order,
   *  and the router cache's pre-pin seed goes with it before back-navigation can
   *  replay it. */
  async function togglePin(playlist: PlaylistSummaryItem) {
    const pinned = playlist.pinnedAt === null;
    setActionError(null);
    const result = await pinLibraryPlaylist(playlist.id, pinned);
    if (!result.ok) {
      setActionError(pinToggleFailure(pinned, result.error.message));
      return;
    }
    router.refresh();
    await loadRef.current();
  }

  async function confirmDelete(playlist: PlaylistSummaryItem) {
    const result = await deletePlaylist(playlist.id);
    setAction(null);
    if (!result.ok) {
      setActionError(`Delete failed: ${result.error.message}`);
      return;
    }
    setPlaylists((all) => all?.filter((p) => p.id !== playlist.id) ?? all);
  }

  return (
    <>
      <LibrarySearchField placeholder="Search playlists and their tracks…" onSearch={setSearch} />
      {actionError ? <AlertBanner className="mt-4">{actionError}</AlertBanner> : null}
      {playlists === null ? (
        actionError ? null : (
          <LoadingRow className="mt-6 py-8" label="Loading Playlists…" />
        )
      ) : (
        <>
          <PlaylistsGridContent
            curatedPlaylists={curatedPlaylists ?? []}
            searchQuery={search}
            onCreate={() => setAction({ kind: 'create' })}
            actions={{
              onPlay: (playlist) => void playPlaylist(playlist),
              onAddTracks: (playlist) => void startAddTracks(playlist),
              onManageCover: (playlist) => setAction({ kind: 'cover', playlist }),
              onRename: (playlist) => setAction({ kind: 'rename', playlist }),
              onDelete: (playlist) => setAction({ kind: 'delete', playlist }),
              onShare: (playlist) => setAction({ kind: 'share', playlist }),
              onTogglePin: (playlist) => void togglePin(playlist),
            }}
          />
          {nextCursor ? (
            <LoadMoreButton
              loading={loadingMore}
              onClick={() => void loadMore()}
              className="mt-4"
            />
          ) : null}
        </>
      )}
      {action?.kind === 'create' ? (
        <RenameDialog
          heading="New playlist"
          currentName=""
          maxLength={MAX_PLAYLIST_NAME_LENGTH}
          confirmLabel="Create"
          busyLabel="Creating…"
          onRename={create}
          onClose={() => setAction(null)}
        />
      ) : null}
      {action?.kind === 'rename' ? (
        <RenameDialog
          heading="Rename Playlist"
          currentName={action.playlist.name}
          maxLength={MAX_PLAYLIST_NAME_LENGTH}
          onRename={(name) => applyRename(action.playlist, name)}
          onClose={() => setAction(null)}
        />
      ) : null}
      {action?.kind === 'delete' ? (
        <ConfirmDialog
          heading="Delete Playlist"
          body={deletePlaylistConfirmBody(action.playlist)}
          confirmLabel="Delete"
          onConfirm={() => confirmDelete(action.playlist)}
          onClose={() => setAction(null)}
        />
      ) : null}
      <SharePlaylistSheet
        playlist={action?.kind === 'share' ? action.playlist : null}
        onClose={() => setAction(null)}
        onShared={({ playlistId, sharedAt }) =>
          setPlaylists(
            (all) => all?.map((p) => (p.id === playlistId ? { ...p, sharedAt } : p)) ?? all,
          )
        }
      />
      {action?.kind === 'add-tracks' ? (
        <AddTracksSheet
          open
          playlistId={action.playlist.id}
          existingTrackIds={action.memberIds}
          onClose={() => setAction(null)}
          onAdded={() => void load()}
        />
      ) : null}
      {action?.kind === 'cover' ? (
        <PlaylistCoverSheet
          playlist={action.playlist}
          open
          onClose={() => setAction(null)}
          onCoverChanged={(coverImageId) => {
            setAction((current) =>
              current?.kind === 'cover'
                ? { ...current, playlist: { ...current.playlist, coverImageId } }
                : current,
            );
            setPlaylists(
              (all) =>
                all?.map((p) => (p.id === action.playlist.id ? { ...p, coverImageId } : p)) ?? all,
            );
          }}
        />
      ) : null}
    </>
  );
}

export function PlaylistsGridContent({
  curatedPlaylists,
  searchQuery = '',
  onCreate,
  actions,
}: {
  /** Hand-picked playlists only — the caller filters with `isCuratedPlaylist`. */
  curatedPlaylists: PlaylistSummaryItem[];
  /** The active search; a no-result grid renders "no matches", not the starter copy. */
  searchQuery?: string;
  onCreate: () => void;
  actions: PlaylistCardActions;
}) {
  return (
    <>
      {curatedPlaylists.length === 0 ? <PlaylistsEmpty searchQuery={searchQuery} /> : null}
      {/* Column counts follow the shell's bands, not the viewport: below `desk`
          the content column is a fixed --shell-col, so a viewport-keyed step
          there would squeeze cards into a column that never grew. */}
      <div
        data-testid="playlists-grid"
        className="mt-4 grid grid-cols-2 gap-4 desk:grid-cols-3 wide:grid-cols-4"
      >
        <OnlineOnly>
          <button
            type="button"
            onClick={onCreate}
            data-testid="new-playlist-tile"
            className={cn(
              cardClass,
              'grid min-h-[150px] place-items-center border-dashed text-muted transition hover:border-line-2 hover:text-fore',
            )}
          >
            <span className="flex flex-col items-center gap-2 text-[13.5px]">
              <Plus className="h-5 w-5" aria-hidden /> New playlist
            </span>
          </button>
        </OnlineOnly>
        {curatedPlaylists.map((playlist) => (
          <PlaylistCard key={playlist.id} playlist={playlist} actions={actions} />
        ))}
      </div>
    </>
  );
}

function PlaylistCard({
  playlist,
  actions,
}: {
  playlist: PlaylistSummaryItem;
  actions: PlaylistCardActions;
}) {
  return (
    <PlaylistCardShell
      href={`/library/playlist/${playlist.id}`}
      openLabel={`Open ${playlist.name}`}
      coverImageId={playlist.coverImageId}
      mosaicCoverImageIds={playlist.mosaicCoverImageIds}
      onPlay={() => actions.onPlay(playlist)}
      playLabel={`Play ${playlist.name}`}
      playTestId={`playlist-play-${playlist.id}`}
      testId={`playlist-card-${playlist.id}`}
      trailing={<PlaylistCardMenu playlist={playlist} actions={actions} />}
      coverFlag={
        playlist.pinnedAt ? (
          <span
            role="img"
            aria-label="Pinned"
            data-testid={`playlist-pinned-${playlist.id}`}
            className={cn(playlistCardPinFlagClass, 'text-lamp')}
          >
            <Pin className="h-[13px] w-[13px] fill-current" aria-hidden />
          </span>
        ) : undefined
      }
    >
      <div className="truncate text-[14px] font-semibold">{playlist.name}</div>
      <div className={cn('mt-1', playlistCardMetaLineClass)}>
        <OfflineMark kind="playlist" id={playlist.id} />
        {formatPlaylistCardMeta(playlist)}
      </div>
      <div className={playlistCardMetaLineClass}>
        Edited <RelativeTime iso={playlist.updatedAt} />
      </div>
      {/* The consent cue: the owner always sees what they expose. */}
      {playlist.sharedAt ? (
        <div
          className={cn(playlistCardMetaLineClass, 'flex items-center gap-1 text-lamp')}
          data-testid={`playlist-in-lounge-${playlist.id}`}
        >
          <Armchair className="h-3 w-3 shrink-0" aria-hidden />
          In the Lounge
        </div>
      ) : null}
    </PlaylistCardShell>
  );
}

function PlaylistsEmpty({ searchQuery }: { searchQuery: string }) {
  if (searchQuery) {
    return (
      <EmptyState icon={<ListMusic className="h-6 w-6" />} title="No matches" className="mt-4">
        No playlist name, Track, or genre in a playlist matches “{searchQuery}”.
      </EmptyState>
    );
  }
  return (
    <EmptyState icon={<ListMusic className="h-6 w-6" />} title="No playlists yet" className="mt-4">
      Saving a Track files it into a playlist — or start one here and add tracks from your Library.
    </EmptyState>
  );
}

function PlaylistCardMenu({
  playlist,
  actions,
}: {
  playlist: PlaylistSummaryItem;
  actions: PlaylistCardActions;
}) {
  const [open, setOpen] = useState(false);

  function pick(action: (playlist: PlaylistSummaryItem) => void) {
    setOpen(false);
    action(playlist);
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        aria-label={`Options for ${playlist.name}`}
        data-testid={`playlist-menu-${playlist.id}`}
        className={cn(menuTriggerClass, 'relative z-20 -mr-1 -mt-1')}
      >
        <EllipsisVertical className="h-[17px] w-[17px]" aria-hidden />
      </SheetTrigger>
      <PlaylistOptionsSheetContent playlist={playlist}>
        <MenuRow
          icon={<Play className="fill-current" />}
          label="Play"
          description="Play its tracks in order"
          onClick={() => pick(actions.onPlay)}
        />
        <MenuRow
          onlineOnly
          icon={<Pin className={cn(playlist.pinnedAt && 'fill-current')} />}
          label={playlist.pinnedAt ? 'Unpin Playlist' : 'Pin Playlist'}
          description={
            playlist.pinnedAt ? 'Stop listing it first' : 'List it first in your playlists'
          }
          data-testid={`playlist-menu-pin-${playlist.id}`}
          onClick={() => pick(actions.onTogglePin)}
        />
        <MenuRow
          onlineOnly
          icon={<Plus />}
          label="Add Tracks"
          description={MENU_COPY.addTracksFromHistory}
          onClick={() => pick(actions.onAddTracks)}
        />
        <MenuRow
          onlineOnly
          icon={<ImageIcon />}
          label={playlist.coverImageId ? 'Change Cover' : 'Add Cover'}
          description={MENU_COPY.chooseCover}
          onClick={() => pick(actions.onManageCover)}
        />
        <MenuRow
          onlineOnly
          icon={<Pencil />}
          label="Rename Playlist"
          description={MENU_COPY.renamePlaylist}
          onClick={() => pick(actions.onRename)}
        />
        <MenuRow
          onlineOnly
          icon={<Armchair />}
          label={playlist.sharedAt ? 'Edit Sharing' : 'Share Playlist in the Lounge'}
          description="Choose who can listen to it in the lounge"
          data-testid={`playlist-menu-share-${playlist.id}`}
          onClick={() => pick(actions.onShare)}
        />
        <MenuRow
          onlineOnly
          icon={<Download />}
          label="Download Playlist"
          description={MENU_COPY.downloadAllTracks}
          disabled={!canDownloadPlaylist(playlist)}
          data-testid={`playlist-menu-download-${playlist.id}`}
          onClick={() => pick((item) => startFileDownload(playlistDownloadUrl(item.id)))}
        />
        <MenuRow
          onlineOnly
          icon={<Trash2 />}
          label="Delete Playlist"
          description={MENU_COPY.deletePlaylist}
          tone="danger"
          data-testid={`playlist-menu-delete-${playlist.id}`}
          onClick={() => pick(actions.onDelete)}
        />
      </PlaylistOptionsSheetContent>
    </Sheet>
  );
}
