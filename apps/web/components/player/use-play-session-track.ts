'use client';

// A Track plays through its origin Session; a deleted origin uses the caller's preview.

import { useEffect, useRef, useState } from 'react';
import { playSessionTrack } from '@/lib/api-client';
import { useClientId } from '@/lib/use-client-id';
import type { PreviewState } from '@/components/library/track-row';
import { primePlayerAutoplay } from './autoplay-arm';
import { resolveTrackPlayIntent, type TrackPlayTarget } from './play-track-intent';
import { usePlayerContext } from './player-provider';
import { engagedSourceId } from './player-provider-model';

export type { TrackPlayTarget } from './play-track-intent';

export function usePlaySessionTrack(onError: (message: string) => void, onStarted?: () => void) {
  const { playback, engage, engagedSource, pending, beginOtherMusic } = usePlayerContext();
  const source = pending?.source ?? engagedSource;
  const sourceId = source ? engagedSourceId(source) : null;
  const clientId = useClientId();
  const [busyTrackId, setBusyTrackId] = useState<string | null>(null);
  // The source selected at tap time rides along: only a source chosen AFTER
  // the tap abandons the jump, never one that was already arming.
  const [pendingJump, setPendingJump] = useState<{
    track: TrackPlayTarget;
    tapSourceId: string | null;
  } | null>(null);
  const busy = useRef(false);
  // Bumped when something else takes the audio (a preview), so a selection
  // still waiting on the server never starts over it.
  const selection = useRef(0);
  const latest = useRef({ playback, onError, onStarted, sourceId });
  latest.current = { playback, onError, onStarted, sourceId };

  function settle() {
    busy.current = false;
    setBusyTrackId(null);
    setPendingJump(null);
  }

  useEffect(() => {
    if (!pendingJump) return;
    const { track, tapSourceId } = pendingJump;
    const player = playback?.session?.id === track.originSessionId ? playback.player : null;
    if (!player || (sourceId !== track.originSessionId && sourceId !== tapSourceId)) {
      settle();
      return;
    }
    const slot = player.queueItems.find((item) => item.trackId === track.id);
    if (!slot || !player.playableQueueItemIds.includes(slot.id)) return;
    player.playQueueItem(slot.id);
    settle();
    latest.current.onStarted?.();
  }, [pendingJump, playback, sourceId]);

  useEffect(() => {
    if (!pendingJump) return;
    const timer = setTimeout(() => {
      settle();
      latest.current.onError('Couldn’t load that Track. Please retry.');
    }, 10_000);
    return () => clearTimeout(timer);
  }, [pendingJump]);

  /** False when the track has no session to play through (caller previews). */
  async function playViaSession(track: TrackPlayTarget): Promise<boolean> {
    if (busy.current) return true;
    const intent = resolveTrackPlayIntent(track, playback?.player.currentTrack?.trackId ?? null);
    if (intent.kind === 'toggle') {
      playback?.player.toggle();
      return true;
    }
    if (intent.kind === 'preview') return false;
    // The tap is the browser's autoplay gesture — prime before any await.
    primePlayerAutoplay();
    if (playback?.session?.id !== track.originSessionId && !(await beginOtherMusic())) {
      return true;
    }
    busy.current = true;
    setBusyTrackId(track.id);
    const tap = ++selection.current;
    const result = await playSessionTrack(intent.sessionId, track.id, clientId);
    if (selection.current !== tap) return true;
    // A newer source selection owns playback even if this request finishes later.
    if (latest.current.sourceId !== sourceId) {
      settle();
      return true;
    }
    if (!result.ok) {
      settle();
      onError(`Couldn’t play that Track: ${result.error.message}`);
      return true;
    }
    const current = latest.current.playback;
    if (current?.session?.id === track.originSessionId) {
      // Re-engaging a hosted Session refreshes its summary, not its playback
      // cursor. Wait for the positioned Queue to include an older selection.
      setPendingJump({ track, tapSourceId: sourceId });
      current.player.refreshQueue();
    } else {
      settle();
      engage(result.data.session, { autoplay: true });
      latest.current.onStarted?.();
    }
    return true;
  }

  /** Drop a selection still waiting on the server or the Queue: other audio took over. */
  function supersede() {
    if (!busy.current) return;
    selection.current += 1;
    settle();
  }

  // The transport's answer to "how should this row render" — the same shape
  // the page-local preview reports, so rows read one state either way.
  const transportRowPreview: { trackId: string | null; state: PreviewState } = {
    trackId: playback?.player.currentTrack?.trackId ?? null,
    state: playback?.player.status === 'playing' ? 'playing' : 'paused',
  };

  return { playViaSession, busyTrackId, transportRowPreview, supersede };
}
