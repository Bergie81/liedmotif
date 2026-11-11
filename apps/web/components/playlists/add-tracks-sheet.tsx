'use client';

// Multi-select "Add Tracks" for a playlist (add-to-playlist is a
// track-level action with multi-select): browse the full History, check any
// number of tracks, committed through `addPlaylistTracks` in batches of its
// per-request limit. Existing members are shown
// checked and locked (no duplicates). Adding implies Save.

import { useEffect, useMemo, useState } from 'react';
import type { LibraryTrackItem } from '@liedmotif/shared';
import { Disc3 } from 'lucide-react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { addPlaylistTracks, getLibrary } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { coverArtSrc } from '@/components/player/player-presentation';
import { Sheet, SheetContent, SheetHeader } from '@/components/ui/sheet';
import { AlertBanner, CheckIndicator, menuRowClass } from '@/components/ui/design-system';
import { primaryButtonClass, secondaryButtonClass } from '@/components/ui/form-styles';
import { LoadingRow, LiedmotifLoader } from '@/components/ui/loading';
import { formatTrackDuration } from '@/components/library/library-view-model';
import { appendUniqueById } from '@/lib/append-unique';

/** The most Track ids one `addPlaylistTracks` request takes. */
const ADD_BATCH = 100;

export function AddTracksSheet({
  open,
  playlistId,
  existingTrackIds,
  onClose,
  onAdded,
}: {
  open: boolean;
  playlistId: string;
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
  existingTrackIds,
  onClose,
  onAdded,
}: {
  playlistId: string;
  existingTrackIds: string[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const router = useRouter();
  const [tracks, setTracks] = useState<LibraryTrackItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const members = useMemo(() => new Set(existingTrackIds), [existingTrackIds]);

  async function loadPage(cursor: string | null) {
    const result = await getLibrary('history', { cursor });
    if (!result.ok) {
      setError(`Couldn’t load your tracks: ${result.error.message}`);
      return;
    }
    setTracks((current) => appendUniqueById(current ?? [], result.data.items));
    setNextCursor(result.data.nextCursor);
  }

  // Initial load only; paging goes through the explicit "Load more" button.
  useEffect(() => {
    void loadPage(null);
  }, []);

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
    setError(null);
    // One add takes at most ADD_BATCH Tracks; adds are idempotent and append in
    // request order, so consecutive batches keep the picked order and a retry
    // after a failed batch adds only what is still missing.
    const trackIds = [...checked];
    for (let start = 0; start < trackIds.length; start += ADD_BATCH) {
      const result = await addPlaylistTracks(playlistId, trackIds.slice(start, start + ADD_BATCH));
      if (!result.ok) {
        setBusy(false);
        setError(`Adding failed: ${result.error.message}`);
        if (start > 0) {
          router.refresh();
          onAdded();
        }
        return;
      }
    }
    setBusy(false);
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
      {error ? <AlertBanner className="mt-4">{error}</AlertBanner> : null}
      {tracks === null && !error ? (
        <LoadingRow className="mt-6 py-6" label="Loading Tracks…" />
      ) : null}
      {tracks ? (
        <div className="mt-4" role="group" aria-label="Tracks">
          {tracks.map((track) => {
            const isMember = members.has(track.id);
            const isChecked = isMember || checked.has(track.id);
            return (
              <button
                key={track.id}
                type="button"
                role="checkbox"
                aria-checked={isChecked}
                disabled={busy || isMember}
                onClick={() => toggle(track.id)}
                className={cn(menuRowClass, 'w-full', isMember && 'opacity-50')}
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
                  {formatTrackDuration(track.durationSeconds)}
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
              onClick={() => {
                setLoadingMore(true);
                void loadPage(nextCursor).finally(() => setLoadingMore(false));
              }}
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
