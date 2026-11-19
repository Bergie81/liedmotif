'use client';

// Reordering as a mode. Drags are buffered against the order the mode opened
// with, so Cancel costs nothing and Done is one atomic write — no half-applied
// order can exist, and no drag spends a round trip the owner may undo.

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { PlaylistMemberItem } from '@liedmotif/shared';
import { setPlaylistOrder } from '@/lib/http/api-client';
import { sameTrackOrder } from './playlist-view-model';

export interface ReorderMode {
  active: boolean;
  /** The commit is in flight — both ways out of the mode are held. */
  saving: boolean;
  /** Enter the mode against the given full member list — the caller just
   *  loaded and set it, so the hook's `items` prop cannot carry it until the
   *  next render. */
  start: (withItems: PlaylistMemberItem[]) => void;
  cancel: () => void;
  commit: () => void;
}

export function useReorderPlaylist({
  playlistId,
  items,
  setItems,
  onError,
  onConflict,
}: {
  playlistId: string;
  /** The live order, or null while the playlist is still loading. */
  items: PlaylistMemberItem[] | null;
  setItems: (items: PlaylistMemberItem[]) => void;
  onError: (message: string) => void;
  /** The membership moved under the mode — neither order in hand is the truth,
   *  so the caller reads it back. */
  onConflict: () => void;
}): ReorderMode {
  // The order as it stood when the mode was entered — non-null means the mode
  // is on, and Cancel puts it back.
  const router = useRouter();
  const [openedWith, setOpenedWith] = useState<PlaylistMemberItem[] | null>(null);
  const [saving, setSaving] = useState(false);

  const cancel = useCallback(() => {
    if (!openedWith) return;
    setItems(openedWith);
    setOpenedWith(null);
  }, [openedWith, setItems]);

  // Escape leaves the mode, as it does every other overlay in the app. A
  // keyboard drag claims Escape first to abort itself, and marks the event
  // handled — one press ends one thing.
  useEffect(() => {
    if (!openedWith || saving) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !event.defaultPrevented) cancel();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openedWith, saving, cancel]);

  function start(withItems: PlaylistMemberItem[]) {
    setOpenedWith(withItems);
    // The mode's Cancel/Done sit above the list — scroll to them, or on a long
    // playlist the way out of the mode is off-screen.
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function commit() {
    if (!items || !openedWith) return;
    const trackIds = items.map((item) => item.id);
    if (sameTrackOrder(openedWith, trackIds)) {
      setOpenedWith(null);
      return;
    }
    setSaving(true);
    const result = await setPlaylistOrder(playlistId, trackIds);
    setSaving(false);
    setOpenedWith(null);
    if (result.ok) {
      router.refresh();
      return;
    }
    onError(`Reorder failed: ${result.error.message}`);
    if (result.error.code === 'conflict') onConflict();
    else setItems(openedWith);
  }

  return { active: openedWith !== null, saving, start, cancel, commit };
}
