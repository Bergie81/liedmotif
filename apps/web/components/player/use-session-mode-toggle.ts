'use client';

// The Session's generation policy as one controller, shared by every surface
// that can flip it. Enabling Keep Going arms a five-second grace period during
// which nothing is written, so an accidental tap can be taken back before paid
// generation is allowed; switching back to Repeat is written at once. Anything
// that makes an armed activation stale — a different Session, a mode changed
// elsewhere, this player losing the right to write, the tab going away —
// discards it, and a response that outlives its Session is dropped unread.

import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { SessionMode, SessionSummary } from '@liedmotif/shared';
import { setSessionMode } from '@/lib/api-client';

export interface SessionModeToggleProps {
  sessionMode: SessionMode;
  pending: boolean;
  disabled: boolean;
  onToggle: () => void;
}

export function useSessionModeToggle({
  sessionId,
  sessionMode,
  available,
  onSessionChange,
  onError,
}: {
  sessionId: string;
  sessionMode: SessionMode;
  /** Whether this player may write the Session's policy at all. */
  available: boolean;
  onSessionChange: (session: SessionSummary) => void;
  onError: (message: string | null) => void;
}): SessionModeToggleProps {
  const [phase, setPhase] = useState<'idle' | 'pending' | 'saving'>('idle');
  const writeEpoch = useRef(0);

  // What the interaction was aimed at is gone: drop the armed activation, and
  // disown any write still out (its Session or policy is no longer the one the
  // owner acted on).
  useEffect(() => {
    setPhase('idle');
    return () => {
      writeEpoch.current += 1;
    };
  }, [sessionId, sessionMode, available]);

  async function save(mode: SessionMode) {
    const startedAt = writeEpoch.current;
    setPhase('saving');
    const result = await setSessionMode(sessionId, mode);
    // A response belongs to the Session and policy that initiated the write.
    if (writeEpoch.current !== startedAt) return;
    setPhase('idle');
    if (result.ok) onSessionChange(result.data.session);
    else onError(result.error.message);
  }

  // The timer can outrun the effect that would have disarmed it, so expiry
  // re-reads the conditions the activation was armed under.
  const activate = useEffectEvent(() => {
    if (available && sessionMode === 'repeat' && document.visibilityState === 'visible') {
      void save('keep_going');
    } else setPhase('idle');
  });
  useEffect(() => {
    if (phase !== 'pending') return;
    const timer = setTimeout(activate, 5000);
    const cancel = () => {
      clearTimeout(timer);
      setPhase('idle');
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') cancel();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', cancel);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', cancel);
    };
  }, [phase]);

  const disabled = !available || phase === 'saving';
  return {
    sessionMode,
    pending: phase === 'pending',
    disabled,
    onToggle() {
      if (disabled) return;
      onError(null);
      if (sessionMode === 'keep_going') void save('repeat');
      else setPhase(phase === 'pending' ? 'idle' : 'pending');
    },
  };
}
