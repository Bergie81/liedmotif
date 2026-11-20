'use client';

// The two confirms that take a playlist out of the Lounge. Each purges for
// everyone but the owner: a re-share restores the playlist's Lounge presence,
// never the Members' Pins or Shared references — so the dialog says so before
// it runs. Each dialog owns its write; the caller only reacts to the outcome.

import { moderateLoungePlaylist, sharePlaylist } from '@/lib/http/api-client';
import { ConfirmDialog } from '@/components/confirm-dialog';
import type { ShareResult } from '@/components/playlists/share-playlist-sheet';

interface LoungeDialogPlaylist {
  id: string;
  name: string;
}

/** The owner's own unshare, from any surface that lists their playlist. */
export function RemoveFromLoungeDialog({
  playlist,
  onRemoved,
  onError,
  onClose,
}: {
  playlist: LoungeDialogPlaylist;
  onRemoved: (result: ShareResult) => void;
  onError: (message: string) => void;
  onClose: () => void;
}) {
  async function remove() {
    const result = await sharePlaylist(playlist.id, null);
    onClose();
    if (!result.ok) {
      onError(`Removing it from the Lounge failed: ${result.error.message}`);
      return;
    }
    onRemoved({ playlistId: result.data.playlistId, sharedAt: result.data.sharedAt });
  }
  return (
    <ConfirmDialog
      heading="Remove from Lounge"
      body={`“${playlist.name}” leaves the Lounge and turns Private. Every pin of it, yours included, is removed, and others lose any saved shared references to its tracks that no other playlist of yours in the Lounge still holds — sharing it again won’t bring them back. You keep the playlist and its tracks.`}
      confirmLabel="Remove"
      onConfirm={remove}
      onClose={onClose}
    />
  );
}

/** The Admin's single cross-owner write: the share returns to Private through
 *  the owner's own unshare path, and the owner keeps the playlist. */
export function ReturnToPrivateDialog({
  playlist,
  owner,
  onReturned,
  onError,
  onClose,
}: {
  playlist: LoungeDialogPlaylist;
  /** The owner's display name, as the Lounge attributes the share. */
  owner: string;
  onReturned: () => void;
  onError: (message: string) => void;
  onClose: () => void;
}) {
  async function returnToPrivate() {
    const result = await moderateLoungePlaylist(playlist.id);
    onClose();
    if (!result.ok) {
      onError(`Couldn’t return the playlist to Private: ${result.error.message}`);
      return;
    }
    onReturned();
  }
  return (
    <ConfirmDialog
      heading="Return to Private"
      body={`“${playlist.name}” by ${owner} leaves the Lounge. Every pin of it, ${owner}’s included, is removed, and other members lose any saved shared references to its tracks that no other shared playlist of ${owner}’s still holds — sharing it again won’t bring them back. ${owner} keeps the playlist and its tracks.`}
      confirmLabel="Return to Private"
      onConfirm={returnToPrivate}
      onClose={onClose}
    />
  );
}
