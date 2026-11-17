'use client';

// What the app around the chat lends a card: the budget readout the shell
// already shows, and the app's own flows a confirmed card runs. The flows are
// the ones behind the app's buttons, so a card can do nothing a button cannot.

import { useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type {
  ChangeVibeIntentInput,
  StartSessionRequest,
  StartSurpriseRequest,
} from '@liedmotif/shared';
import type { GenerationHeadroom } from '@/components/app-shell-model';
import { usePlayerContext } from '@/components/player/player-provider';
import { currentPendingStart } from '@/components/player/session-handoff';
import { switchNewMusicOn } from '@/components/player/switch-new-music-on';
import { useHandOffStart } from '@/components/player/use-hand-off-start';
import { useSeedMoreLikeThis } from '@/components/sessions/use-seed-more-like-this';
import { startSession, startSurprise } from '@/lib/api-client';
import { useClientId } from '@/lib/use-client-id';

/** What one of the app's flows came to. */
export interface CardFlowResult {
  carriedOut: boolean;
  /** Why not, as the app words it, when the flow has no other place that shows it. */
  refusal?: string;
}

/** A flow a click started; null when the click sent nothing and the card may be confirmed again. */
type CardFlow = Promise<CardFlowResult> | null;

export interface CardHost {
  /** What is left of the budget, as the shell's own readout has it; null when nothing counts down. */
  headroom: GenerationHeadroom | null;
  /** Reads that figure again: a card is about to show it. */
  refreshHeadroom: () => void;
  /**
   * Starts a Session the way Home's Start button does, hand-off to the Player
   * included. Null when another Start is still in flight. A refusal shows on
   * the Player.
   */
  startSession: (request: Omit<StartSessionRequest, 'clientId'>) => CardFlow;
  /**
   * Starts a Surprise Me suggestion the way Home's Surprise Me does, hand-off
   * to the Player included. Null when another Start is still in flight. A
   * refusal shows on the Player, and on the card: a suggestion replaced or
   * dismissed elsewhere is not one the Player can name.
   */
  startSurprise: (request: StartSurpriseRequest) => CardFlow;
  /**
   * Changes the vibe through the player's own Change Vibe request. Null when
   * another change is still in flight. A refusal shows where the player shows
   * that request's.
   */
  changeVibe: (sessionId: string, input: ChangeVibeIntentInput) => CardFlow;
  /**
   * Starts More Like This the way the Library's Track menu does, hand-off to
   * the Player included. Null when a Start is still in flight: the app goes to
   * the Player that narrates it.
   */
  moreLikeThis: (seedTrackIds: string[]) => CardFlow;
  /**
   * Saves New music on the way the player's New music sheet does; null minutes
   * is No limit. The player and the mini player follow.
   */
  newMusicOn: (sessionId: string, targetMinutes: number | null) => CardFlow;
}

export function useCardHost(
  headroom: GenerationHeadroom | null,
  /** Re-reads what the shell shows of the budget and of the active Session. */
  refreshChrome: () => void,
): CardHost {
  const handOffStart = useHandOffStart();
  const seedMoreLikeThis = useSeedMoreLikeThis();
  const clientId = useClientId();
  const router = useRouter();
  const { playback, engage, submitChangeVibe } = usePlayerContext();
  // A flow runs long after the render that handed it out, and the seeding
  // hook returns a new function with every render.
  const live = useRef({ playback, seedMoreLikeThis });
  useEffect(() => {
    live.current = { playback, seedMoreLikeThis };
  });
  return useMemo(
    () => ({
      headroom,
      refreshHeadroom: refreshChrome,
      startSession: (request) =>
        handOffStart((signal) => startSession({ ...request, clientId }, signal))?.then(
          (result) => ({ carriedOut: result.ok }),
        ) ?? null,
      startSurprise: (request) =>
        handOffStart((signal) => startSurprise(request, signal))?.then((result) =>
          result.ok ? { carriedOut: true } : { carriedOut: false, refusal: result.error.message },
        ) ?? null,
      changeVibe: (sessionId, input) =>
        submitChangeVibe(sessionId, input, {})?.then((carriedOut) => ({ carriedOut })) ?? null,
      moreLikeThis(seedTrackIds) {
        // The seed flow would ask whether to replace a Start that is still
        // setting up. A card leaves that Start alone, as a Session card does.
        if (currentPendingStart()) {
          router.push('/player');
          return null;
        }
        return live.current
          .seedMoreLikeThis(seedTrackIds)
          .then((failure) =>
            failure === null ? { carriedOut: true } : { carriedOut: false, refusal: failure },
          );
      },
      newMusicOn: (sessionId, targetMinutes) =>
        switchNewMusicOn(sessionId, targetMinutes).then((result) => {
          if (!result.ok) {
            return {
              carriedOut: false,
              refusal: `New music didn’t switch on: ${result.error.message}`,
            };
          }
          const { session } = result.data;
          // The same Session engaged again is its summary refreshed in place.
          if (live.current.playback?.session?.id === session.id) {
            engage(session, { autoplay: false });
          }
          // The shell's own copy of the active Session, which the mini player
          // shows while nothing is engaged.
          refreshChrome();
          return { carriedOut: true };
        }),
    }),
    [headroom, refreshChrome, handOffStart, clientId, router, engage, submitChangeVibe],
  );
}
