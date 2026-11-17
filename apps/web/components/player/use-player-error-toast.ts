'use client';

import { useEffect } from 'react';
import { toast } from '@/lib/toast';

/** One key for every Now Playing surface, so the surface that takes over the
 *  Player clears the failure the one before it reported. */
const PLAYER_ERROR_KEY = 'player-error';

/** Shows the Player's current failures as one error toast. The failures are
 *  state the actions clear when they are tried again, so the toast follows
 *  them: new text replaces it, and an empty one closes it. */
export function usePlayerErrorToast(message: string): void {
  useEffect(() => {
    if (message) toast.error(message, { key: PLAYER_ERROR_KEY });
    else toast.dismiss(PLAYER_ERROR_KEY);
  }, [message]);
}
