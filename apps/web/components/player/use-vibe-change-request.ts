'use client';

// The provider-scoped Change Vibe workflow: a fire-and-forget submit with
// single-flight, pending, and error state. Lives beside — not inside — the
// PlayerProvider so the audio-host orchestrator stays about playback hosting;
// the provider mounts this once (giving the request its cross-route lifetime)
// and hands the result through its context.
//
// This gate is DELIBERATELY independent of the player hook's Stop/More Like
// This gate: stopping must never wait on a pending restyle. A Stop that beats
// an in-flight change makes the late restyle fail server-side against the
// no-longer-active session; the late success is dropped by the caller's
// engagement guard, and the session-scoped error only surfaces where that
// session still renders — so the race resolves without a mis-applied write.
// A submit that arrives while one is in flight is dropped by the gate and
// answered null; the player disables its triggers on `pendingSessionId`, and a
// surface that cannot see that state reads the null.

import { useCallback, useMemo, useRef, useState } from 'react';
import type { ChangeVibeIntentInput, SessionSummary } from '@liedmotif/shared';
import { changeVibe, setSessionDuration, type ChangeVibeOptions } from '@/lib/api-client';
import {
  runPlayerSessionAction,
  type PlayerSessionActionGate,
} from './player-session-action-runner';
import { clearPlayerError, showPlayerError } from './player-error-toast';

/** The Change Vibe request narration the player surfaces read. */
export interface VibeChangeState {
  /** The session whose Change Vibe request is in flight, or null. */
  pendingSessionId: string | null;
  /** The last failed submit, scoped to its session; cleared on the next submit. */
  error: { sessionId: string; message: string } | null;
}

export function useVibeChangeRequest(
  /** Applies the restyled summary — the caller owns the "is this session still
   * the engaged source" guard, since it owns the engagement model. */
  applyRestyledSession: (session: SessionSummary) => void,
): {
  vibeChange: VibeChangeState;
  /** Resolves with whether the change was saved. Null when one is already in
   * flight: this one was dropped and nothing was sent. */
  submitChangeVibe: (
    sessionId: string,
    input: ChangeVibeIntentInput | undefined,
    options: ChangeVibeOptions,
  ) => Promise<boolean> | null;
} {
  const gate = useRef<PlayerSessionActionGate>({ active: null });
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [error, setError] = useState<VibeChangeState['error']>(null);

  const submitChangeVibe = useCallback(
    (sessionId: string, input: ChangeVibeIntentInput | undefined, options: ChangeVibeOptions) => {
      if (gate.current.active) return null;
      return runPlayerSessionAction({
        gate: gate.current,
        action: 'change-vibe',
        failureLabel: 'Change Vibe failed',
        // The sheet submits a duration-only edit without an intent; that is a
        // Session policy write, not a restyle, so it takes the duration route.
        request: () =>
          input
            ? changeVibe(sessionId, input, options)
            : setSessionDuration(sessionId, options.targetDurationMinutes ?? null),
        onBusyChange: (action) => setPendingSessionId(action ? sessionId : null),
        // The failure is also an error toast, raised here, where it happens,
        // so it shows once on whatever page the listener is on.
        onFailure: (err) => {
          setError(err ? { sessionId, message: err.message } : null);
          if (err) showPlayerError(sessionId, 'change-vibe', err.message);
          else clearPlayerError(sessionId, 'change-vibe');
        },
        onSuccess: (data) => applyRestyledSession(data.session),
      });
    },
    [applyRestyledSession],
  );

  const vibeChange = useMemo<VibeChangeState>(
    () => ({ pendingSessionId, error }),
    [pendingSessionId, error],
  );
  return { vibeChange, submitChangeVibe };
}
