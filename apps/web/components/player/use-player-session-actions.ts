'use client';

import { useCallback, useRef, useState } from 'react';
import type { SessionSummary } from '@liedmotif/shared';
import { convertSessionToPlaylist, moreLikeThis, stopSession } from '@/lib/api-client';
import { useClientId } from '@/lib/use-client-id';
import { usePlayerActions } from './player-provider';
import {
  runPlayerSessionAction,
  type PlayerSessionActionGate,
} from './player-session-action-runner';

/** The actions THIS hook runs — Change Vibe has its own provider-scoped runner. */
export type PlayerHookAction = 'convert-to-playlist' | 'more-like-this' | 'stop';

export interface PlayerHookActionError {
  action: PlayerHookAction;
  message: string;
}

export function usePlayerSessionActions({
  sessionId,
  trackId,
  onSessionChange,
  onStopped,
  onConverted,
}: {
  sessionId: string;
  trackId: string | null;
  onSessionChange: (session: SessionSummary) => void;
  onStopped: () => void;
  onConverted: (playlistId: string) => void;
}) {
  const clientId = useClientId();
  const { beginOtherMusic } = usePlayerActions();
  const actionGate = useRef<PlayerSessionActionGate>({ active: null });
  const [busyAction, setBusyAction] = useState<PlayerHookAction | null>(null);
  const [error, setError] = useState<PlayerHookActionError | null>(null);

  const startMoreLikeThis = useCallback(async (): Promise<boolean> => {
    if (!trackId) return false;
    if (!(await beginOtherMusic())) return false;
    return runPlayerSessionAction({
      gate: actionGate.current,
      action: 'more-like-this',
      failureLabel: 'More Like This failed',
      request: () => moreLikeThis([trackId], clientId),
      onBusyChange: setBusyAction,
      onFailure: setError,
      onSuccess: (data) => onSessionChange(data.session),
    });
  }, [clientId, beginOtherMusic, onSessionChange, trackId]);

  const stop = useCallback(async () => {
    return runPlayerSessionAction({
      gate: actionGate.current,
      action: 'stop',
      failureLabel: 'Stop failed',
      request: () => stopSession(sessionId),
      onBusyChange: setBusyAction,
      onFailure: setError,
      onSuccess: onStopped,
    });
  }, [onStopped, sessionId]);

  const convertToPlaylist = useCallback(async () => {
    return runPlayerSessionAction({
      gate: actionGate.current,
      action: 'convert-to-playlist',
      failureLabel: 'Convert to Playlist failed',
      request: () => convertSessionToPlaylist(sessionId),
      onBusyChange: setBusyAction,
      onFailure: setError,
      onSuccess: (data) => onConverted(data.playlistId),
    });
  }, [onConverted, sessionId]);

  return {
    busyAction,
    error,
    startMoreLikeThis,
    stop,
    convertToPlaylist,
  };
}
