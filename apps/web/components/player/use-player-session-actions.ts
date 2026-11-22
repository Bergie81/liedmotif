'use client';

import { useCallback, useRef, useState } from 'react';
import type { SessionSummary } from '@liedmotif/shared';
import { convertSessionToPlaylist, moreLikeThis, stopSession } from '@/lib/http/api-client';
import { useClientId } from '@/lib/use-client-id';
import { MORE_LIKE_THIS_FAILED } from '@/components/create/creation-refusal';
import { clearPlayerError, showPlayerError } from './player-error-toast';
import { usePlayerActions } from './player-provider';
import {
  runPlayerSessionAction,
  type PlayerSessionActionGate,
} from './player-session-action-runner';
import type { MoreLikeThisAsk } from '@/components/sessions/more-like-this-sheet';

/** The actions THIS hook runs — Change Vibe has its own provider-scoped runner. */
export type PlayerHookAction = 'convert-to-playlist' | 'more-like-this' | 'stop';

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
  // A failure is an error toast; the action's next run clears it.
  const reportFailure = useCallback(
    (failure: { action: PlayerHookAction; message: string } | null, action: PlayerHookAction) => {
      if (failure) showPlayerError(sessionId, action, failure.message);
      else clearPlayerError(sessionId, action);
    },
    [sessionId],
  );

  const startMoreLikeThis = useCallback(
    async (ask: MoreLikeThisAsk = {}): Promise<boolean> => {
      if (!trackId) return false;
      if (!(await beginOtherMusic())) return false;
      return runPlayerSessionAction({
        gate: actionGate.current,
        action: 'more-like-this',
        failureLabel: MORE_LIKE_THIS_FAILED,
        createsSession: true,
        request: () => moreLikeThis({ seedTrackIds: [trackId], clientId, ...ask }),
        onBusyChange: setBusyAction,
        onFailure: (failure) => reportFailure(failure, 'more-like-this'),
        onSuccess: (data) => onSessionChange(data.session),
      });
    },
    [clientId, beginOtherMusic, onSessionChange, reportFailure, trackId],
  );

  const stop = useCallback(async () => {
    return runPlayerSessionAction({
      gate: actionGate.current,
      action: 'stop',
      failureLabel: 'Stop failed',
      request: () => stopSession(sessionId),
      onBusyChange: setBusyAction,
      onFailure: (failure) => reportFailure(failure, 'stop'),
      onSuccess: onStopped,
    });
  }, [onStopped, reportFailure, sessionId]);

  const convertToPlaylist = useCallback(async () => {
    return runPlayerSessionAction({
      gate: actionGate.current,
      action: 'convert-to-playlist',
      failureLabel: 'Convert to Playlist failed',
      request: () => convertSessionToPlaylist(sessionId),
      onBusyChange: setBusyAction,
      onFailure: (failure) => reportFailure(failure, 'convert-to-playlist'),
      onSuccess: (data) => onConverted(data.playlistId),
    });
  }, [onConverted, reportFailure, sessionId]);

  return {
    busyAction,
    startMoreLikeThis,
    stop,
    convertToPlaylist,
  };
}
