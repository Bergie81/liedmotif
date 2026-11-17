'use client';

// The Playlist detail page — a pure curation surface. Every act sits
// behind a menu at the altitude it acts on: the Playlist's own behind the
// header's `⋯`, a member's behind its row `⋮` (including More Like This, which
// seeds from that one Track). What is left on the page is the Playlist itself
// and the one thing you do with one: Play.
//
// Member state — the paged loaded prefix, optimistic removal with rollback,
// and the full-membership fetch behind whole-playlist acts — lives in
// `usePlaylistMembers`; this component orchestrates overlays and playback.
// Reordering is a mode that buffers the whole order and commits once, so
// Cancel costs nothing and no half-applied order can exist.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  MAX_PLAYLIST_NAME_LENGTH,
  type LoungePlaylistOwner,
  type PlaylistMemberItem,
} from '@liedmotif/shared';
import { Check, ListMusic, Play } from 'lucide-react';
import {
  deletePlaylist,
  deleteTrack,
  getLoungePlaylist,
  pinLoungePlaylist,
  renamePlaylist,
  type PlaylistPageFetcher,
} from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';
import { AvatarBadge } from '@/components/avatar-badge';
import { ReturnToPrivateDialog } from '@/components/lounge/lounge-confirm-dialogs';
import {
  LOUNGE_MLT_SEED_TRACKS,
  loungeOwnerDisplayName,
} from '@/components/lounge/lounge-view-model';
import { playlistDownloadUrl, startFileDownload } from '@/lib/downloads';
import { RenameDialog } from '@/components/rename-dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { AlertBanner, cardClass, EmptyState } from '@/components/ui/design-system';
import {
  primaryButtonClass,
  roundPrimaryButtonClass,
  secondaryButtonClass,
} from '@/components/ui/form-styles';
import { LoadMoreButton } from '@/components/ui/load-more-button';
import { LoadingRow, LiedmotifLoader } from '@/components/ui/loading';
import { OnlineOnly } from '@/components/ui/online-only';
import { TrackDataSheet } from '@/components/player/track-data-sheet';
import { useSeedMoreLikeThis } from '@/components/sessions/use-seed-more-like-this';
import { AddTracksSheet } from './add-tracks-sheet';
import { PlaylistCoverSheet } from './playlist-cover-sheet';
import { PlaylistHeader } from './playlist-header';
import { PlaylistMemberList } from './playlist-member-list';
import { PlaylistTrackSheet } from './playlist-track-sheet';
import { SaveToPlaylistSheet, type SavePickerTrack } from './save-to-playlist-sheet';
import { deletePlaylistConfirmBody, pinToggleFailure, reindexMembers } from './playlist-view-model';
import { usePlaylistMembers, type PlaylistMembership } from './use-playlist-members';
import { usePlayPlaylist } from './use-play-playlist';
import { useReorderPlaylist } from './use-reorder-playlist';

// A retry of these acts replaces its earlier failure; a success clears it.
const TRACK_DELETE_KEY = 'playlist-track-delete';
const DELETE_KEY = 'playlist-delete';
const PIN_KEY = 'playlist-pin';
const MORE_LIKE_THIS_KEY = 'playlist-more-like-this';

/** At most one overlay is up at a time — two sheets never stack. */
type PlaylistOverlay =
  | { kind: 'rename' }
  | { kind: 'delete' }
  | { kind: 'return-to-private' }
  | { kind: 'add-tracks' }
  | { kind: 'cover' }
  | { kind: 'track-options'; item: PlaylistMemberItem }
  | { kind: 'track-memberships'; track: SavePickerTrack }
  | { kind: 'track-data'; trackId: string };

export function PlaylistDetail({
  playlistId,
  back,
  onTrackCountChange,
  initial,
  visitor,
}: {
  playlistId: string;
  /** Where the way back goes — only a surface that IS a page has one. */
  back?: { href: string; label: string };
  /** Follows the member count through loads and curation (the Favorites tab count). */
  onTrackCountChange?: (count: number) => void;
  /** Server-rendered playlist + first member page: paints immediately and skips
   * the mount fetch; mutations and conflicts still reload over the API. */
  initial?: PlaylistMembership;
  /** The Lounge visitor view: another owner's In-Lounge playlist,
   * read-only — attribution instead of the curation menu, listening only.
   * `owner` is null only when the server render found nothing (the client's
   * own load then surfaces the uniform not-found). `pinned` seeds the Pin
   * toggle from the server render. `isAdmin` unlocks the Return to Private
   * moderation row; the route refuses a Member regardless. */
  visitor?: { owner: LoungePlaylistOwner | null; pinned?: boolean; isAdmin?: boolean };
}) {
  const isVisitor = visitor != null;
  const [pinned, setPinned] = useState(visitor?.pinned ?? false);
  const [seeding, setSeeding] = useState(false);
  const [overlay, setOverlay] = useState<PlaylistOverlay | null>(null);
  const router = useRouter();
  const seed = useSeedMoreLikeThis();

  // The visitor surface pages over the Lounge read; attribution stays with the
  // server render, so the page shape narrows to the owner endpoint's.
  const fetchLoungePage = useCallback<PlaylistPageFetcher>(
    async (cursor, limit) => {
      const result = await getLoungePlaylist(playlistId, cursor, limit);
      if (!result.ok) return result;
      const { playlist, items, nextCursor } = result.data;
      return { ok: true, data: { playlist, items, nextCursor } };
    },
    [playlistId],
  );

  const members = usePlaylistMembers({
    playlistId,
    ...(initial ? { initial } : {}),
    ...(isVisitor ? { fetchPage: fetchLoungePage } : {}),
    onError: toast.error,
    onUnsaved: () =>
      toast.info(
        'Removed — that was its last playlist, so the track left your Library (it stays in History).',
      ),
  });
  const { playlist, items, hasMore, setPlaylist, setItems } = members;

  const trackCount = playlist?.trackCount;
  useEffect(() => {
    if (trackCount !== undefined) onTrackCountChange?.(trackCount);
  }, [trackCount, onTrackCountChange]);

  const playback = usePlayPlaylist(toast.error, { foreign: isVisitor });
  const reorder = useReorderPlaylist({
    playlistId,
    items,
    setItems,
    onError: toast.error,
    onConflict: () => void members.load(),
  });
  const { holdReloads } = members;
  useEffect(() => holdReloads(reorder.active), [holdReloads, reorder.active]);

  async function applyRename(name: string): Promise<string | null> {
    const result = await renamePlaylist(playlistId, name);
    if (!result.ok) return result.error.message;
    setPlaylist((p) => (p ? { ...p, name } : p));
    return null;
  }

  // More Like This: a NEW Session seeded from a member's Track, or from the
  // playlist's first members (the only "more music" path out of a Playlist).
  async function seedMoreLikeThis(trackIds: string[]) {
    if (seeding) return;
    setSeeding(true);
    toast.dismiss(MORE_LIKE_THIS_KEY);
    const failure = await seed(trackIds);
    setSeeding(false);
    if (failure) toast.error(failure, { key: MORE_LIKE_THIS_KEY });
  }

  // Permanent Track delete (never feedback). Settled before the list changes —
  // the confirm dialog is already the deliberate step, so no optimistic remove.
  async function deleteMemberEverywhere(item: PlaylistMemberItem) {
    const result = await deleteTrack(item.id);
    setOverlay(null);
    if (!result.ok) {
      toast.error(`Delete failed: ${result.error.message}`, { key: TRACK_DELETE_KEY });
      return;
    }
    members.dropMember(item);
    toast.dismiss(TRACK_DELETE_KEY);
    toast.success('Track deleted — its audio is removed and it left every Playlist.');
  }

  // The Pin toggle: pure navigation — lists this live
  // playlist first in the viewer's Lounge; grants nothing, and unpin is always
  // the viewer's call. The refresh drops the router cache's pre-pin Lounge before
  // back-navigation can replay it.
  async function togglePin() {
    if (!playlist) return;
    const next = !pinned;
    const result = await pinLoungePlaylist(playlistId, next);
    if (!result.ok) {
      toast.error(pinToggleFailure(next, result.error.message), { key: PIN_KEY });
      return;
    }
    toast.dismiss(PIN_KEY);
    setPinned(result.data.pinned);
    router.refresh();
  }

  async function confirmDelete() {
    const result = await deletePlaylist(playlistId);
    if (!result.ok) {
      toast.error(`Delete failed: ${result.error.message}`, { key: DELETE_KEY });
      setOverlay(null);
      return;
    }
    router.push('/library');
  }

  // Play, reorder and Add Tracks act on the whole playlist, so each completes
  // the loaded prefix first when pages remain.
  async function playAll(startTrackId?: string) {
    if (members.loadingAll) return;
    const full = await members.ensureAllMembers();
    if (full) playback.play(full.playlist, full.items, startTrackId);
  }

  async function startReorder() {
    const full = await members.ensureAllMembers();
    if (full) reorder.start(full.items);
  }

  async function startAddTracks() {
    const full = await members.ensureAllMembers();
    if (full) setOverlay({ kind: 'add-tracks' });
  }

  if (members.loadError) {
    return <AlertBanner className="mt-6">{members.loadError}</AlertBanner>;
  }
  if (!playlist || items === null) {
    return <LoadingRow className="mt-8 py-8" label="Loading Playlist…" />;
  }

  // An unloaded page may still hold the playable member, so Play stays lit
  // while pages remain — the full fetch under it settles the question.
  const hasPlayableTrack = items.some((item) => item.audioUrl !== null) || hasMore;

  const ownerDisplayName = visitor?.owner
    ? loungeOwnerDisplayName(visitor.owner.artistName, visitor.owner.name)
    : null;

  return (
    <>
      <PlaylistHeader
        play={
          <button
            type="button"
            data-testid="playlist-play"
            aria-label="Play"
            disabled={!hasPlayableTrack || members.loadingAll}
            aria-busy={members.loadingAll}
            onClick={() => void playAll()}
            className={cn(roundPrimaryButtonClass, 'disabled:opacity-45')}
          >
            {members.loadingAll ? (
              <LiedmotifLoader />
            ) : (
              <Play className="h-5 w-5 fill-current" aria-hidden />
            )}
          </button>
        }
        playlist={playlist}
        back={back}
        reordering={reorder.active}
        eyebrow={isVisitor ? 'Playlist · In the Lounge' : undefined}
        attribution={
          visitor?.owner && ownerDisplayName ? (
            <p
              data-testid="playlist-owner-attribution"
              className="mt-2 flex items-center gap-1.5 text-[12.5px] text-muted"
            >
              <AvatarBadge
                name={ownerDisplayName}
                imageUrl={visitor.owner.imageUrl}
                className="h-[18px] w-[18px] text-[9px]"
              />
              <span className="truncate">Shared by {ownerDisplayName}</span>
            </p>
          ) : undefined
        }
        visitor={
          isVisitor
            ? {
                pinned,
                actions: {
                  play: () => void playAll(),
                  togglePin: () => void togglePin(),
                  moreLikeThis: () =>
                    void seedMoreLikeThis(
                      items.slice(0, LOUNGE_MLT_SEED_TRACKS).map((item) => item.id),
                    ),
                  returnToPrivate: visitor.isAdmin
                    ? () => setOverlay({ kind: 'return-to-private' })
                    : undefined,
                },
              }
            : undefined
        }
        actions={
          isVisitor
            ? undefined
            : {
                'add-tracks': () => void startAddTracks(),
                rename: () => setOverlay({ kind: 'rename' }),
                reorder: () => void startReorder(),
                cover: () => setOverlay({ kind: 'cover' }),
                download: () => startFileDownload(playlistDownloadUrl(playlist.id)),
                delete: () => setOverlay({ kind: 'delete' }),
              }
        }
      />

      {reorder.active ? (
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            disabled={reorder.saving}
            onClick={reorder.cancel}
            className={cn(secondaryButtonClass, 'flex-1 justify-center')}
          >
            Cancel
          </button>
          <OnlineOnly>
            <button
              type="button"
              data-testid="playlist-reorder-done"
              disabled={reorder.saving}
              aria-busy={reorder.saving}
              onClick={reorder.commit}
              className={cn(primaryButtonClass, 'flex flex-1 items-center justify-center gap-2')}
            >
              {reorder.saving ? <LiedmotifLoader /> : <Check className="h-4 w-4" />} Done
            </button>
          </OnlineOnly>
        </div>
      ) : null}

      <section className="mt-7">
        <div className={cn(cardClass, 'p-3')}>
          {items.length === 0 ? (
            <EmptyState
              icon={<ListMusic className="h-6 w-6" />}
              title="This Playlist has no Tracks"
              className="border-0 py-8"
            >
              {isVisitor
                ? 'Nothing to hear yet — the owner curates this Playlist live.'
                : 'Add Saved Tracks from your Library — they play in the order you set here.'}
            </EmptyState>
          ) : (
            <PlaylistMemberList
              items={items}
              reordering={reorder.active}
              onReorder={(next) => setItems(reindexMembers(next))}
              onPlayFrom={(trackId) => void playAll(trackId)}
              onOpenOptions={(item) => setOverlay({ kind: 'track-options', item })}
            />
          )}
          {hasMore ? (
            <LoadMoreButton
              loading={members.loadingMore}
              disabled={members.removing}
              onClick={() => void members.loadMore()}
              className="mt-3 pb-1"
            />
          ) : null}
        </div>
      </section>

      {overlay?.kind === 'rename' ? (
        <RenameDialog
          heading="Rename Playlist"
          currentName={playlist.name}
          maxLength={MAX_PLAYLIST_NAME_LENGTH}
          onRename={applyRename}
          onClose={() => setOverlay(null)}
        />
      ) : null}

      {overlay?.kind === 'delete' ? (
        <ConfirmDialog
          heading="Delete Playlist"
          body={deletePlaylistConfirmBody(playlist)}
          confirmLabel="Delete"
          onConfirm={confirmDelete}
          onClose={() => setOverlay(null)}
        />
      ) : null}

      {overlay?.kind === 'return-to-private' ? (
        <ReturnToPrivateDialog
          playlist={playlist}
          owner={ownerDisplayName ?? 'the owner'}
          // The share left the Lounge, so the visitor view has nothing left to
          // show and goes back to the room.
          onReturned={() => {
            router.refresh();
            router.push('/lounge');
          }}
          onError={toast.error}
          onClose={() => setOverlay(null)}
        />
      ) : null}

      <AddTracksSheet
        open={overlay?.kind === 'add-tracks'}
        playlistId={playlistId}
        playlistName={playlist.name}
        existingTrackIds={items.map((item) => item.id)}
        onClose={() => setOverlay(null)}
        onAdded={() => void members.load()}
      />

      <PlaylistCoverSheet
        playlist={playlist}
        open={overlay?.kind === 'cover'}
        onClose={() => setOverlay(null)}
        onCoverChanged={(coverImageId) => setPlaylist((p) => (p ? { ...p, coverImageId } : p))}
      />

      <PlaylistTrackSheet
        item={overlay?.kind === 'track-options' ? overlay.item : null}
        visitor={isVisitor}
        onClose={() => setOverlay(null)}
        onRemove={(item) => {
          members.removeMember(item.id);
          setOverlay(null);
        }}
        onAddToPlaylist={(track) => setOverlay({ kind: 'track-memberships', track })}
        onMoreLikeThis={(item) => {
          setOverlay(null);
          void seedMoreLikeThis([item.id]);
        }}
        onOpenTrackData={(item) => setOverlay({ kind: 'track-data', trackId: item.id })}
        onDelete={deleteMemberEverywhere}
      />

      {/* The picker rewrites the Track's WHOLE membership, so it can drop it from
          this playlist too — the list is read back rather than patched. */}
      <SaveToPlaylistSheet
        track={overlay?.kind === 'track-memberships' ? overlay.track : null}
        onClose={() => setOverlay(null)}
        onApplied={() => {
          setOverlay(null);
          void members.load();
        }}
      />

      <TrackDataSheet
        open={overlay?.kind === 'track-data'}
        onOpenChange={(next) => !next && setOverlay(null)}
        trackId={overlay?.kind === 'track-data' ? overlay.trackId : null}
      />
    </>
  );
}
