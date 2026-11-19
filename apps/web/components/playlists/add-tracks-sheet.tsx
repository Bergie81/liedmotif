'use client';

// Multi-select "Add Tracks" for a playlist (add-to-playlist is a
// track-level action with multi-select): browse the full History, check any
// number of tracks, committed through `addTracksInBatches`. Existing members
// are shown checked and locked (no duplicates). Adding implies Save. The search
// box asks the Library server-side, so Tracks past the loaded pages are found;
// picks are ids, so they survive a search.

import { useMemo, useState } from 'react';
import { Disc3 } from 'lucide-react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/cn';
import { coverArtSrc } from '@/components/player/player-presentation';
import { Sheet, SheetContent, SheetHeader } from '@/components/ui/sheet';
import { AlertBanner, CheckIndicator, menuRowClass } from '@/components/ui/design-system';
import { primaryButtonClass, secondaryButtonClass } from '@/components/ui/form-styles';
import { LoadingRow, LiedmotifLoader } from '@/components/ui/loading';
import { LibrarySearchField } from '@/components/library/library-search-field';
import { useLibraryQuery } from '@/components/library/use-library-query';
import { FAILED_TRACK_NOTICE, formatTrackDuration } from '@/components/library/library-view-model';
import { toast } from '@/lib/toast';
import { addTracksInBatches } from './add-tracks-in-batches';
import { addedToPlaylistToast, addToPlaylistFailedMessage } from './playlist-view-model';

const ADD_KEY = 'add-tracks';

export function AddTracksSheet({
  open,
  playlistId,
  playlistName,
  existingTrackIds,
  onClose,
  onAdded,
}: {
  open: boolean;
  playlistId: string;
  /** Names the Playlist in the toast that confirms the add. */
  playlistName: string;
  existingTrackIds: string[];
  onClose: () => void;
  /** The commit landed — the caller reloads its membership. */
  onAdded: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      {open ? (
        <AddTracksContent
          playlistId={playlistId}
          playlistName={playlistName}
          existingTrackIds={existingTrackIds}
          onClose={onClose}
          onAdded={onAdded}
        />
      ) : null}
    </Sheet>
  );
}

function AddTracksContent({
  playlistId,
  playlistName,
  existingTrackIds,
  onClose,
  onAdded,
}: {
  playlistId: string;
  playlistName: string;
  existingTrackIds: string[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const {
    items: tracks,
    nextCursor,
    error: loadError,
    loadingMore,
    loadMore,
  } = useLibraryQuery('history', search);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const members = useMemo(() => new Set(existingTrackIds), [existingTrackIds]);

  function toggle(trackId: string) {
    if (members.has(trackId)) return;
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
  }

  async function commit() {
    if (checked.size === 0 || busy) return;
    setBusy(true);
    toast.dismiss(ADD_KEY);
    const trackIds = [...checked];
    const result = await addTracksInBatches(playlistId, trackIds);
    setBusy(false);
    if (!result.ok) {
      toast.error(addToPlaylistFailedMessage(result.error.message), { key: ADD_KEY });
      if (result.partial) {
        router.refresh();
        onAdded();
      }
      return;
    }
    const { tone, message } = addedToPlaylistToast(result.data, playlistName);
    toast[tone](message);
    router.refresh();
    onAdded();
    onClose();
  }

  return (
    <SheetContent side="bottom" className="overflow-y-auto" data-testid="add-tracks-sheet">
      <SheetHeader
        title="Add Tracks"
        closeDisabled={busy}
        description="Pick any generated tracks — adding keeps them in your Library."
      />
      <LibrarySearchField
        width="fill"
        placeholder="Search titles, prompts, genres, moods…"
        onSearch={setSearch}
      />
      {loadError ? (
        <AlertBanner className="mt-4">Couldn’t load your tracks: {loadError}</AlertBanner>
      ) : null}
      {tracks === null && !loadError ? (
        <LoadingRow className="mt-6 py-6" label="Loading Tracks…" />
      ) : null}
      {tracks ? (
        <div className="mt-4" role="group" aria-label="Tracks">
          {tracks.length === 0 && search ? (
            <p className="px-1 text-[13.5px] text-muted">No tracks match “{search}”.</p>
          ) : null}
          {tracks.map((track) => {
            const isMember = members.has(track.id);
            const isChecked = isMember || checked.has(track.id);
            // A failed Track's final never arrived: it can never join a Playlist.
            const failed = track.status === 'failed';
            return (
              <button
                key={track.id}
                type="button"
                role="checkbox"
                aria-checked={isChecked}
                disabled={busy || isMember || failed}
                onClick={() => toggle(track.id)}
                className={cn(menuRowClass, 'w-full', (isMember || failed) && 'opacity-50')}
              >
                <span className="relative h-9 w-9 shrink-0 overflow-hidden rounded-[8px] bg-panel-2">
                  {track.coverImageId ? (
                    <Image
                      src={coverArtSrc(track.coverImageId, 'thumb')}
                      alt=""
                      fill
                      className="object-cover"
                    />
                  ) : (
                    <Disc3 className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 text-muted" />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-left">
                  {track.title ?? 'Untitled Track'}
                </span>
                <span className="font-mono text-[10.5px] tracking-[0.04em] text-dim">
                  {failed ? FAILED_TRACK_NOTICE : formatTrackDuration(track.durationSeconds)}
                </span>
                <CheckIndicator checked={isChecked} />
              </button>
            );
          })}
          {nextCursor ? (
            <button
              type="button"
              className={cn(secondaryButtonClass, 'mt-3 w-full')}
              disabled={loadingMore || busy}
              aria-busy={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? <LiedmotifLoader /> : null}
              Load more
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="mt-5 flex gap-2">
        <button
          type="button"
          className={cn(secondaryButtonClass, 'flex-1')}
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className={cn(primaryButtonClass, 'flex-1')}
          disabled={busy || checked.size === 0}
          aria-busy={busy}
          onClick={() => void commit()}
          data-testid="add-tracks-commit"
        >
          {busy ? <LiedmotifLoader /> : null}
          {checked.size > 0 ? `Add ${checked.size}` : 'Add'}
        </button>
      </div>
    </SheetContent>
  );
}
