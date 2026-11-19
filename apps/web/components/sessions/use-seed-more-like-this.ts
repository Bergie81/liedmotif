'use client';

import { useRouter } from 'next/navigation';
import type { ApiErrorCode } from '@liedmotif/shared';
import { moreLikeThis } from '@/lib/api-client';
import { useClientId } from '@/lib/use-client-id';
import { usePlayerActions } from '@/components/player/player-provider';

/** Why the seeding API refused, as the server said it. */
export interface SeedRefusal {
  code: ApiErrorCode;
  message: string;
}

/**
 * Start a NEW Session seeded from Tracks, from a surface that is not the player
 * (Library, Playlist). Two constraints live here. The seeding call must run
 * inside the tap handler, because priming is the browser's one autoplay gesture
 * for the session host that may mount behind audible playback. And the new
 * Session must be ENGAGED before `/player` is shown: that page reattaches to
 * whatever source is already engaged, so navigating alone would land on the old
 * source and the seeded Session would never appear.
 *
 * Resolves to the refusal, code and all, on failure and null on success: the
 * calling surface decides how to show it (the blocked dialog for a headroom
 * refusal) and owns its own busy state.
 */
export function useSeedMoreLikeThis(): (
  trackIds: string[],
  /** The length the user chose for the new Session; none for the app's own More Like This. */
  targetDurationMinutes?: number,
) => Promise<SeedRefusal | null> {
  const clientId = useClientId();
  const router = useRouter();
  const { engage, beginOtherMusic } = usePlayerActions();

  return async function seedMoreLikeThis(trackIds, targetDurationMinutes) {
    if (!(await beginOtherMusic())) return null;
    const result = await moreLikeThis(trackIds, clientId, targetDurationMinutes);
    if (!result.ok) return { code: result.error.code, message: result.error.message };
    engage(result.data.session, { autoplay: false });
    router.push('/player');
    return null;
  };
}
