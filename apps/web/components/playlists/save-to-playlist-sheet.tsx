'use client';

// The save picker (retention is membership): saving a Track means filing it into
// at least one Playlist. One shared bottom sheet for the player Save button, the
// Library options sheet, and "Add to Playlist" — a checklist of the playlists
// the owner curates (checked = already a member), a "New playlist" row at the
// head of the list, and one atomic commit through `applyTrackMemberships`.
//
// That commit rewrites the Track's whole membership set, so a membership the
// list never offers (Favorites, which the star owns) has to ride along with it,
// or saving would unfile the Track as a side effect. Unsave is the exception:
// leaving every playlist means EVERY playlist, so unchecking the
// list commits the empty set — which is why the commit button renames itself
// rather than warning about it.

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { isCuratedPlaylist, type PlaylistSummaryItem } from '@liedmotif/shared';
import { Armchair, ListMusic, Plus } from 'lucide-react';
import {
  applyTrackMemberships,
  getAllPlaylists,
  type ApplyTrackMembershipsData,
} from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';
import { Sheet, SheetContent, SheetHeader } from '@/components/ui/sheet';
import { AlertBanner, CheckIndicator, menuRowClass } from '@/components/ui/design-system';
import { inputClass, primaryButtonClass, secondaryButtonClass } from '@/components/ui/form-styles';
import { LoadingRow, LiedmotifLoader } from '@/components/ui/loading';
import { CoverThumb } from '@/components/player/cover-art';

const SAVE_FAILED_KEY = 'save-to-playlist';

export interface SavePickerTrack {
  id: string;
  title: string | null;
  savedAt: string | null;
  /** The art the surface that opened the picker is showing for this Track. */
  coverImageId: string | null;
}

export function SaveToPlaylistSheet({
  track,
  onClose,
  onApplied,
}: {
  /** The track being filed; null keeps the sheet closed/unmounted. */
  track: SavePickerTrack | null;
  onClose: () => void;
  /** The commit landed — flags + membership for the caller to sync its UI. */
  onApplied: (data: ApplyTrackMembershipsData) => void;
}) {
  return (
    <Sheet open={track !== null} onOpenChange={(open) => !open && onClose()}>
      {track ? <PickerContent track={track} onClose={onClose} onApplied={onApplied} /> : null}
    </Sheet>
  );
}

function PickerContent({
  track,
  onClose,
  onApplied,
}: {
  track: SavePickerTrack;
  onClose: () => void;
  onApplied: (data: ApplyTrackMembershipsData) => void;
}) {
  /** Every playlist the owner has — the list shows the curated ones, and the
   *  rest are the memberships the commit has to carry. */
  const router = useRouter();
  const [playlists, setPlaylists] = useState<PlaylistSummaryItem[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getAllPlaylists({ containsTrackId: track.id }).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setLoadError(`Couldn’t load your playlists: ${result.error.message}`);
        return;
      }
      const all = result.data.playlists;
      setPlaylists(all);
      // `checked` opens with the memberships the rows can show, and nothing
      // else: preselecting anything but a real membership would file the Track
      // where the owner never put it, and a membership no row can reach would
      // keep the set non-empty where unchecking every row means Unsave.
      setChecked(
        new Set(all.filter((p) => isCuratedPlaylist(p) && p.containsTrack).map((p) => p.id)),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [track.id]);

  const unlistedMembershipIds = (playlists ?? [])
    .filter((p) => !isCuratedPlaylist(p) && p.containsTrack)
    .map((p) => p.id);
  const trimmedNewName = newName.trim();
  const willBeSaved = checked.size > 0 || trimmedNewName.length > 0;
  // Committing an empty set leaves EVERY playlist, which is the one
  // thing this sheet does that is not saving — the commit button says so itself.
  const removesFromLibrary = !willBeSaved && track.savedAt !== null;
  // An unsaved Track with nothing chosen has nothing to commit.
  const canCommit = !busy && playlists !== null && (willBeSaved || track.savedAt !== null);

  function toggle(playlistId: string) {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(playlistId)) next.delete(playlistId);
      else next.add(playlistId);
      return next;
    });
  }

  async function commit() {
    if (!canCommit) return;
    setBusy(true);
    const result = await applyTrackMemberships({
      trackId: track.id,
      // Unsave leaves every playlist, the unlisted ones included; any other
      // commit keeps them, since it rewrites the Track's whole set.
      playlistIds: willBeSaved ? [...checked, ...unlistedMembershipIds] : [],
      createPlaylistName: trimmedNewName || null,
    });
    setBusy(false);
    if (!result.ok) {
      toast.error(`Saving failed: ${result.error.message}`, { key: SAVE_FAILED_KEY });
      return;
    }
    toast.dismiss(SAVE_FAILED_KEY);
    router.refresh();
    onApplied(result.data);
    onClose();
  }

  return (
    <SheetContent side="bottom" className="overflow-y-auto" data-testid="save-picker-sheet">
      <SheetHeader
        leading={<CoverThumb coverImageId={track.coverImageId} />}
        title="Save to Playlists"
        closeDisabled={busy}
        // A Track title is the one part of this sheet with no length to rely
        // on, so it truncates as a block — `truncate` on an inline box only
        // suppresses the wrap and lets the line run past the header.
        description={<span className="block truncate">{track.title ?? 'Untitled Track'}</span>}
      />
      {loadError ? <AlertBanner className="mt-4">{loadError}</AlertBanner> : null}

      {playlists === null && !loadError ? (
        <LoadingRow className="mt-6 py-6" label="Loading Playlists…" />
      ) : null}

      {playlists ? (
        <div className="mt-4" role="group" aria-label="Playlists">
          {/* Making a playlist heads the list: it is the one row whose place
              cannot depend on how many playlists the owner already has. Its rule
              stays the rows' — a hairline separates it from what follows it. */}
          {creating ? (
            <div className="border-b border-line pb-3 last:border-b-0">
              <input
                className={cn(inputClass, 'w-full')}
                value={newName}
                maxLength={60}
                autoFocus
                placeholder="New playlist name"
                aria-label="New playlist name"
                disabled={busy}
                onChange={(event) => setNewName(event.target.value)}
              />
            </div>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => setCreating(true)}
              className={cn(menuRowClass, 'w-full')}
              data-testid="picker-new-playlist"
            >
              <Plus className="h-[18px] w-[18px]" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-left">New playlist</span>
            </button>
          )}

          {playlists.filter(isCuratedPlaylist).map((playlist) => {
            const isChecked = checked.has(playlist.id);
            return (
              <button
                key={playlist.id}
                type="button"
                role="checkbox"
                aria-checked={isChecked}
                disabled={busy}
                onClick={() => toggle(playlist.id)}
                className={cn(menuRowClass, 'w-full')}
                data-testid="picker-playlist"
              >
                <ListMusic className="h-[18px] w-[18px]" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-left">{playlist.name}</span>
                {/* The consent cue: filing a Track here makes it
                    instantly audible to everyone on the Instance. */}
                {playlist.sharedAt ? (
                  <span
                    className="flex items-center gap-1 font-mono text-[10.5px] uppercase tracking-[0.04em] text-lamp"
                    data-testid={`picker-in-lounge-${playlist.id}`}
                  >
                    <Armchair className="h-3 w-3 shrink-0" aria-hidden />
                    In the Lounge
                  </span>
                ) : null}
                <span className="font-mono text-[10.5px] tracking-[0.04em] text-dim">
                  {playlist.trackCount}
                </span>
                <CheckIndicator checked={isChecked} />
              </button>
            );
          })}
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
          disabled={!canCommit}
          aria-busy={busy}
          onClick={() => void commit()}
          data-testid="picker-commit"
        >
          {busy ? <LiedmotifLoader /> : null}
          {removesFromLibrary ? 'Remove from Library' : 'Save'}
        </button>
      </div>
    </SheetContent>
  );
}
