'use client';

import { useEffect } from 'react';
import { toast } from '@/lib/toast';

/** Shows one of the Player's current failures as its own error toast. The
 *  failure is state its action clears when it is tried again, so the toast
 *  follows it: new text replaces it, and none closes it. One toast per source,
 *  so a failure the listener closed stays closed while another comes and goes.
 *  The Session and Playlist surfaces name their shared sources alike, so the
 *  surface that takes over the Player clears what the one before it reported. */
export function usePlayerErrorToast(source: string, message: string | null | undefined): void {
  useEffect(() => {
    const key = `player-error:${source}`;
    if (message) toast.error(message, { key });
    else toast.dismiss(key);
  }, [source, message]);
}
