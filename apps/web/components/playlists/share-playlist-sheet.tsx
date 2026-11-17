'use client';

// The Lounge share picker: the owner chooses who an
// In-Lounge playlist reaches — All (everyone, Users who join later included),
// None, or individual Users — and commits it in one write. The audience rules
// live in the view model; this sheet loads, renders, and sends.

import { useEffect, useState } from 'react';
import type { PlaylistSummaryItem } from '@liedmotif/shared';
import { getPlaylistShare, sharePlaylist, type PlaylistShareData } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';
import { AvatarBadge } from '@/components/avatar-badge';
import { loungeOwnerDisplayName } from '@/components/lounge/lounge-view-model';
import { Sheet, SheetContent, SheetHeader } from '@/components/ui/sheet';
import {
  AlertBanner,
  CheckIndicator,
  chipClass,
  menuRowClass,
} from '@/components/ui/design-system';
import { primaryButtonClass, secondaryButtonClass } from '@/components/ui/form-styles';
import { LoadingRow, LiedmotifLoader } from '@/components/ui/loading';
import { PlaylistCover } from './playlist-cover';
import {
  initialShareSelection,
  isShareTicked,
  shareCommit,
  toggleShareSelection,
  type ShareSelection,
} from './share-playlist-view-model';

const SHARE_KEY = 'share-playlist';

/** What the sheet shows of the playlist — any playlist listing can open it. */
type SharedPlaylist = Pick<
  PlaylistSummaryItem,
  'id' | 'name' | 'coverImageId' | 'mosaicCoverImageIds'
>;

export interface ShareResult {
  playlistId: string;
  sharedAt: string | null;
}

export function SharePlaylistSheet({
  playlist,
  onClose,
  onShared,
}: {
  /** The playlist being shared; null keeps the sheet closed/unmounted. */
  playlist: SharedPlaylist | null;
  onClose: () => void;
  /** The write landed — the new share state for the caller to sync its UI. */
  onShared: (result: ShareResult) => void;
}) {
  return (
    <Sheet open={playlist !== null} onOpenChange={(open) => !open && onClose()}>
      {playlist ? <ShareContent playlist={playlist} onClose={onClose} onShared={onShared} /> : null}
    </Sheet>
  );
}

function ShareContent({
  playlist,
  onClose,
  onShared,
}: {
  playlist: SharedPlaylist;
  onClose: () => void;
  onShared: (result: ShareResult) => void;
}) {
  const [share, setShare] = useState<PlaylistShareData | null>(null);
  const [selection, setSelection] = useState<ShareSelection>(new Set());
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getPlaylistShare(playlist.id).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setLoadError(`Couldn’t load sharing: ${result.error.message}`);
        return;
      }
      setShare(result.data);
      setSelection(initialShareSelection(result.data.audience, result.data.candidates));
    });
    return () => {
      cancelled = true;
    };
  }, [playlist.id]);

  const candidates = share?.candidates ?? [];
  const commit = share ? shareCommit({ selection, candidates, current: share.audience }) : null;

  async function confirm() {
    if (!commit || commit.disabled || busy) return;
    setBusy(true);
    const result = await sharePlaylist(playlist.id, commit.audience);
    setBusy(false);
    if (!result.ok) {
      toast.error(
        `${commit.audience ? 'Sharing' : 'Returning to Private'} failed: ${result.error.message}`,
        { key: SHARE_KEY },
      );
      return;
    }
    toast.dismiss(SHARE_KEY);
    onShared({ playlistId: result.data.playlistId, sharedAt: result.data.sharedAt });
    onClose();
  }

  return (
    <SheetContent side="bottom" className="overflow-y-auto" data-testid="share-playlist-sheet">
      <SheetHeader
        title="Share to the Lounge"
        closeDisabled={busy}
        description={<span className="block truncate">{playlist.name}</span>}
        leading={
          <PlaylistCover
            coverImageId={playlist.coverImageId}
            mosaicCoverImageIds={playlist.mosaicCoverImageIds}
            thumb
            className="h-12 w-12 shrink-0 rounded-[10px]"
          />
        }
      />
      {loadError ? <AlertBanner className="mt-4">{loadError}</AlertBanner> : null}
      {share === null && !loadError ? (
        <LoadingRow className="mt-6 py-6" label="Loading sharing…" />
      ) : null}

      {share ? (
        <>
          <p className="mt-4 text-[13.5px] leading-relaxed text-muted">
            {candidates.length === 0
              ? 'You’re the only one here for now. Sharing reaches everyone on this instance, including people you invite later.'
              : 'Pick who can listen. All includes people who join later.'}{' '}
            It stays live — you keep curating, and you can return it to Private at any time.
          </p>

          {candidates.length > 0 ? (
            <>
              <div className="mt-4 flex gap-2" role="group" aria-label="Select">
                <button
                  type="button"
                  className={chipClass}
                  aria-pressed={selection === 'everyone'}
                  disabled={busy}
                  onClick={() => setSelection('everyone')}
                  data-testid="share-select-all"
                >
                  All
                </button>
                <button
                  type="button"
                  className={chipClass}
                  aria-pressed={selection !== 'everyone' && selection.size === 0}
                  disabled={busy}
                  onClick={() => setSelection(new Set())}
                  data-testid="share-select-none"
                >
                  None
                </button>
              </div>
              <div className="mt-2" role="group" aria-label="People">
                {candidates.map((candidate) => {
                  const label = loungeOwnerDisplayName(candidate.artistName, candidate.name);
                  const isChecked = isShareTicked(selection, candidate.userId);
                  return (
                    <button
                      key={candidate.userId}
                      type="button"
                      role="checkbox"
                      aria-checked={isChecked}
                      disabled={busy}
                      onClick={() =>
                        setSelection((current) =>
                          toggleShareSelection(current, candidate.userId, candidates),
                        )
                      }
                      className={cn(menuRowClass, 'w-full')}
                      data-testid={`share-candidate-${candidate.userId}`}
                    >
                      <AvatarBadge
                        name={label}
                        imageUrl={candidate.imageUrl}
                        className="h-7 w-7 text-[12px]"
                      />
                      <span className="min-w-0 flex-1 text-left">
                        <span className="block truncate">{label}</span>
                        {candidate.name !== label ? (
                          <span className="block truncate text-[12px] text-muted">
                            {candidate.name}
                          </span>
                        ) : null}
                      </span>
                      <CheckIndicator checked={isChecked} />
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}
        </>
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
          disabled={!commit || commit.disabled || busy}
          aria-busy={busy}
          onClick={() => void confirm()}
          data-testid="share-commit"
        >
          {busy ? <LiedmotifLoader /> : null}
          {commit?.label ?? 'Share'}
        </button>
      </div>
    </SheetContent>
  );
}
