'use client';

import { useRouter } from 'next/navigation';
import { moreLikeThis } from '@/lib/api-client';
import { useClientId } from '@/lib/use-client-id';
import { usePlayerActions } from '@/components/player/player-provider';

/**
 * Start a NEW Session seeded from Tracks, from a surface that is not the player
 * (Library, Playlist). Two constraints live here. The seeding call must run
 * inside the tap handler, because priming is the browser's one autoplay gesture
 * for the session host that may mount behind audible playback. And the new
 * Session must be ENGAGED before `/player` is shown: that page reattaches to
 * whatever source is already engaged, so navigating alone would land on the old
 * source and the seeded Session would never appear.
 *
 * Resolves to a user-facing message on failure and null on success; the calling
 * surface owns its own busy state.
 */
export function useSeedMoreLikeThis(): (trackIds: string[]) => Promise<string | null> {
  const clientId = useClientId();
  const router = useRouter();
  const { engage, beginOtherMusic } = usePlayerActions();

  return async function seedMoreLikeThis(trackIds) {
    if (!(await beginOtherMusic())) return null;
    const result = await moreLikeThis(trackIds, clientId);
    if (!result.ok) return `More Like This didn’t start: ${result.error.message}`;
    engage(result.data.session, { autoplay: false });
    router.push('/player');
    return null;
  };
}
