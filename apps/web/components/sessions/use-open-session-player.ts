'use client';

import { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '@liedmotif/shared';
import { usePlayerContext } from '@/components/player/player-provider';
import { engagedSourceId } from '@/components/player/player-provider-model';
import { listSessions, resumeSession } from '@/lib/api-client';
import { useClientId } from '@/lib/use-client-id';

/** Open a Session at its saved position; an already-engaged Session keeps its transport state. */
export function useOpenSessionPlayer(onOpened: () => void) {
  const { engagedSource, pending, engage, beginOtherMusic } = usePlayerContext();
  const clientId = useClientId();
  const source = pending?.source ?? engagedSource;
  const sourceId = source ? engagedSourceId(source) : null;
  const latest = useRef({ sourceId, onOpened, engage });
  latest.current = { sourceId, onOpened, engage };
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ sessionId: string; message: string } | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function open(sessionId: string) {
    if (inFlight.current) return;
    setError(null);
    if (
      source?.kind === 'session' &&
      source.session.id === sessionId &&
      source.session.status !== 'stopped'
    ) {
      onOpened();
      return;
    }
    inFlight.current = true;
    if (!(await beginOtherMusic())) {
      inFlight.current = false;
      return;
    }
    setBusy(true);
    const isCurrentIntent = () => mounted.current && latest.current.sourceId === sourceId;
    try {
      const sessions = await listSessions({ includeActive: true, limit: 1 });
      if (!isCurrentIntent()) return;
      if (!sessions.ok) {
        setError({ sessionId, message: sessions.error.message });
        return;
      }
      let session: SessionSummary | null =
        sessions.data.activeSession?.id === sessionId ? sessions.data.activeSession : null;
      if (!session) {
        const resumed = await resumeSession(sessionId, clientId);
        if (!isCurrentIntent()) return;
        if (!resumed.ok) {
          setError({ sessionId, message: resumed.error.message });
          return;
        }
        session = resumed.data.session;
      }
      latest.current.engage(session, { autoplay: true });
      latest.current.onOpened();
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return { open, busy, error, clearError: () => setError(null) };
}
