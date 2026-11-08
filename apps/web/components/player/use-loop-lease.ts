'use client';

// React binding of the repeat-one lease protocol:
// one `LoopLeaseProtocol` per (session, client) speaking the
// acknowledged `/api/sessions/loop-lease` endpoint, with `held` mirroring the
// server-acknowledged session-level hold. The protocol semantics — monotonic
// epochs, latest-wins acks, self-healing renewal — live (and are unit-tested)
// in `loop-lease-protocol.ts`; this hook only wires React state and teardown.

import { useCallback, useEffect, useRef, useState } from 'react';
import { applyLoopLease } from '@/lib/api-client';
import { LoopLeaseProtocol } from './loop-lease-protocol';

/** What can want automatic generation held: the lease stands while any of them does. */
export type LoopLeaseHolder = 'loop-track' | 'section-loop';

export interface LoopLeaseClient {
  /** The server-acknowledged hold state (any live lease on the session). */
  held: boolean;
  /** One holder wants the hold, or lets go of it. */
  hold: (holder: LoopLeaseHolder, wanted: boolean) => void;
  /** Report-cadence tick: renew a live lease, re-acquire a lapsed one. */
  renew: () => void;
}

export function useLoopLease(
  /** Null (a Playlist source) = no lease protocol at all — every call no-ops. */
  sessionId: string | null,
  clientId: string,
  /** The acquire ack did not confirm the hold — surface it to the user. */
  onHoldFailed?: () => void,
): LoopLeaseClient {
  const [held, setHeld] = useState(false);
  const protocolRef = useRef<LoopLeaseProtocol | null>(null);
  const holdersRef = useRef(new Set<LoopLeaseHolder>());
  const onHoldFailedRef = useRef(onHoldFailed);
  onHoldFailedRef.current = onHoldFailed;

  const protocol = useCallback((): LoopLeaseProtocol | null => {
    if (!sessionId) return null;
    protocolRef.current ??= new LoopLeaseProtocol(
      ({ epoch, action, signal }) => applyLoopLease({ sessionId, clientId, epoch, action }, signal),
      setHeld,
      () => onHoldFailedRef.current?.(),
    );
    return protocolRef.current;
  }, [sessionId, clientId]);

  // Best-effort release on unmount (stop/navigation); a lost one lapses by TTL.
  useEffect(
    () => () => {
      protocolRef.current?.dispose();
      protocolRef.current = null;
      holdersRef.current.clear();
    },
    [protocol],
  );

  return {
    held,
    hold: useCallback(
      (holder: LoopLeaseHolder, wanted: boolean) => {
        const holders = holdersRef.current;
        const wasHeld = holders.size > 0;
        if (wanted) holders.add(holder);
        else holders.delete(holder);
        const isHeld = holders.size > 0;
        if (isHeld === wasHeld) return;
        if (isHeld) protocol()?.acquire();
        else protocol()?.release();
      },
      [protocol],
    ),
    renew: useCallback(() => protocol()?.renew(), [protocol]),
  };
}
