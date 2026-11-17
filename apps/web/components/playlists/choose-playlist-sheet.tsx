'use client';

// Pick ONE playlist as the destination for a multi-select add
// (add-to-playlist is a track-level action with multi-select). Tapping a row
// commits immediately; "New playlist" creates and commits in one flow. The
// single-track membership picker is `save-to-playlist-sheet.tsx` — this sheet
// exists for the many-tracks → one-playlist direction.

import { useEffect, useRef, useState } from 'react';
import { MAX_PLAYLIST_NAME_LENGTH, type PlaylistSummaryItem } from '@liedmotif/shared';
import { Armchair, ListMusic, Plus, Star } from 'lucide-react';
import { createPlaylist, getAllPlaylists } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';
import { RenameDialog } from '@/components/rename-dialog';
import { Sheet, SheetContent, SheetHeader } from '@/components/ui/sheet';
import { AlertBanner, menuRowClass } from '@/components/ui/design-system';
import { LoadingRow } from '@/components/ui/loading';

const ADD_FAILED_KEY = 'choose-playlist-add';

export function ChoosePlaylistSheet({
  open,
  trackCount,
  onClose,
  onChoose,
}: {
  open: boolean;
  /** How many tracks the commit will add (the header copy). */
  trackCount: number;
  onClose: () => void;
  /** Commit the add into the chosen playlist; resolve an error message or null. */
  onChoose: (playlistId: string) => Promise<string | null>;
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      {open ? (
        <ChooseContent trackCount={trackCount} onClose={onClose} onChoose={onChoose} />
      ) : null}
    </Sheet>
  );
}

function ChooseContent({
  trackCount,
  onClose,
  onChoose,
}: {
  trackCount: number;
  onClose: () => void;
  onChoose: (playlistId: string) => Promise<string | null>;
}) {
  const [playlists, setPlaylists] = useState<PlaylistSummaryItem[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getAllPlaylists().then((result) => {
      if (cancelled) return;
      if (!result.ok) setLoadError(`Couldn’t load your playlists: ${result.error.message}`);
      else setPlaylists(result.data.playlists);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function choose(playlist: PlaylistSummaryItem) {
    if (busy) return;
    setBusy(true);
    const failure = await onChoose(playlist.id);
    setBusy(false);
    if (failure) {
      toast.error(failure, { key: ADD_FAILED_KEY });
      return;
    }
    landed(playlist.name);
  }

  function landed(playlistName: string) {
    toast.dismiss(ADD_FAILED_KEY);
    toast.success(
      `Added ${trackCount} ${trackCount === 1 ? 'track' : 'tracks'} to ${playlistName}`,
    );
    onClose();
  }

  // A create that succeeded before its add failed: retrying the same name adds
  // to that Playlist instead of minting another empty one.
  const created = useRef<{ name: string; playlistId: string } | null>(null);

  async function createAndChoose(name: string): Promise<string | null> {
    let playlistId = created.current?.name === name ? created.current.playlistId : null;
    if (!playlistId) {
      const result = await createPlaylist(name);
      if (!result.ok) return result.error.message;
      playlistId = result.data.playlist.id;
      created.current = { name, playlistId };
    }
    const failure = await onChoose(playlistId);
    if (!failure) landed(name);
    return failure;
  }

  return (
    <SheetContent side="bottom" className="overflow-y-auto" data-testid="choose-playlist-sheet">
      <SheetHeader
        title="Add to playlist"
        closeDisabled={busy}
        description={`${trackCount} ${trackCount === 1 ? 'track' : 'tracks'} — adding keeps them in your Library.`}
      />
      {loadError ? <AlertBanner className="mt-4">{loadError}</AlertBanner> : null}
      {playlists === null && !loadError ? (
        <LoadingRow className="mt-6 py-6" label="Loading Playlists…" />
      ) : null}
      {playlists ? (
        <div className="mt-4">
          {playlists.map((playlist) => (
            <button
              key={playlist.id}
              type="button"
              disabled={busy}
              onClick={() => void choose(playlist)}
              className={cn(menuRowClass, 'w-full')}
            >
              {playlist.kind === 'favorites' ? (
                <Star className="h-[18px] w-[18px]" aria-hidden />
              ) : (
                <ListMusic className="h-[18px] w-[18px]" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate text-left">{playlist.name}</span>
              {/* The consent cue: adding Tracks here makes them
                  instantly audible to everyone on the Instance. */}
              {playlist.sharedAt ? (
                <span className="flex items-center gap-1 font-mono text-[10.5px] uppercase tracking-[0.04em] text-lamp">
                  <Armchair className="h-3 w-3 shrink-0" aria-hidden />
                  In the Lounge
                </span>
              ) : null}
              <span className="font-mono text-[10.5px] tracking-[0.04em] text-dim">
                {playlist.trackCount}
              </span>
            </button>
          ))}
          <button
            type="button"
            disabled={busy}
            onClick={() => setCreating(true)}
            className={cn(menuRowClass, 'w-full')}
          >
            <Plus className="h-[18px] w-[18px]" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-left">New playlist</span>
          </button>
        </div>
      ) : null}
      {creating ? (
        <RenameDialog
          heading="New playlist"
          currentName=""
          maxLength={MAX_PLAYLIST_NAME_LENGTH}
          confirmLabel="Create"
          busyLabel="Creating…"
          onRename={createAndChoose}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </SheetContent>
  );
}
