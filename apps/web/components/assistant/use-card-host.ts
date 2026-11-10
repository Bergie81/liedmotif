'use client';

// What the app around the chat lends a card: the budget readout the shell
// already shows, and the app's own flows a confirmed card runs. The flows are
// the ones behind the app's buttons, so a card can do nothing a button cannot.

import { useMemo } from 'react';
import type { StartSessionRequest } from '@liedmotif/shared';
import type { GenerationHeadroom } from '@/components/app-shell-model';
import { useHandOffStart } from '@/components/player/use-hand-off-start';
import { startSession } from '@/lib/api-client';
import { useClientId } from '@/lib/use-client-id';

export interface CardHost {
  /** What is left of the budget, as the shell's own readout has it; null when nothing counts down. */
  headroom: GenerationHeadroom | null;
  /** Reads that figure again: a card is about to show it. */
  refreshHeadroom: () => void;
  /**
   * Starts a Session the way Home's Start button does, hand-off to the Player
   * included, and resolves with whether it started. Null when another Start is
   * still in flight: nothing was sent.
   */
  startSession: (request: Omit<StartSessionRequest, 'clientId'>) => Promise<boolean> | null;
}

export function useCardHost(
  headroom: GenerationHeadroom | null,
  refreshHeadroom: () => void,
): CardHost {
  const handOffStart = useHandOffStart();
  const clientId = useClientId();
  return useMemo(
    () => ({
      headroom,
      refreshHeadroom,
      startSession: (request) =>
        handOffStart((signal) => startSession({ ...request, clientId }, signal))?.then(
          (result) => result.ok,
        ) ?? null,
    }),
    [headroom, refreshHeadroom, handOffStart, clientId],
  );
}
