'use client';

import { useRouter } from 'next/navigation';
import type { ApiErrorCode } from '@liedmotif/shared';
import { moreLikeThis } from '@/lib/http/api-client';
import { useClientId } from '@/lib/use-client-id';
import { usePlayerActions } from '@/components/player/player-provider';

/** Why the seeding API refused, as the server said it. */
export interface SeedRefusal {
  code: ApiErrorCode;
  message: string;
}

/** How a seeding tap ended: started, refused by the server (`refusal`), or
 *  neither, when the user kept a Start that is still setting up. */
export interface SeedOutcome {
  started: boolean;
  refusal: SeedRefusal | null;
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
 * A refusal comes back code and all: the calling surface decides how to show
 * it (the blocked dialog for a headroom refusal) and owns its own busy state.
 */
export function useSeedMoreLikeThis(): (
  trackIds: string[],
  /** The length the user chose for the new Session; none for the app's own More Like This. */
  targetDurationMinutes?: number,
  /** What the new Session is about or for, as typed; none names it from the seed alone. */
  context?: string,
) => Promise<SeedOutcome> {
  const clientId = useClientId();
  const router = useRouter();
  const { engage, beginOtherMusic } = usePlayerActions();

  return async function seedMoreLikeThis(trackIds, targetDurationMinutes, context) {
    if (!(await beginOtherMusic())) return { started: false, refusal: null };
    const result = await moreLikeThis(trackIds, clientId, targetDurationMinutes, context);
    if (!result.ok) {
      return {
        started: false,
        refusal: { code: result.error.code, message: result.error.message },
      };
    }
    engage(result.data.session, { autoplay: false });
    router.push('/player');
    return { started: true, refusal: null };
  };
}
