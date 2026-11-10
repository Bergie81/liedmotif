'use client';

// The now-playing controller.
//
// Owns two <audio> decks + the Web Audio PlayerEngine, derives the playable
// projection of the server-authoritative Session Queue (membership + normal
// Session order), and delegates blend transitions to the `EdgeTransitions`
// driver — which resolves every edge at the tier the edge policy decides:
// `beat-aligned` when both tracks carry qualifying measured analysis, `plain`
// otherwise. When Web Audio is unavailable or blending is switched off,
// playback is strictly SEQUENTIAL (advance on `ended`, never two audible
// decks).
//
// Deck sources load through the pinned-URL ladder (final → stream; the
// committed source kind IS the pinned URL that loaded), led by the
// Track's stored copy when this device keeps it Available offline; Back/restart
// re-runs the ladder, making restart a real load boundary.
//
// All mutable playback bookkeeping lives in refs so the media-element event
// handlers never read stale React state; React state is a render mirror only.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  bufferTransportEligible,
  crossfadeStartSeconds,
  mediaSessionPositionState,
  nextPlaylistIndex,
  type PlaybackReportType,
  type PlaybackMode,
  previousPlaylistIndex,
  reanchorPlaylistIndex,
  resolveOrderedNextIndex,
  resolveInitialPlaylistIndex,
  resolveSeekTarget,
  sectionLoopEligible,
  soloLoudnessGainDb,
} from '@liedmotif/shared';
import { reportPlayback } from '@/lib/api-client';
import { isOnline } from '@/lib/online-state';
import { storedTrackAudio } from '@/lib/offline/device-offline';
import { useClientId } from '@/lib/use-client-id';
import { makeUuid } from '@/lib/uuid';
import { useListeningMeter } from './use-listening-meter';
import { PlayerEngine, type DeckId } from './audio-engine';
import { AudioResourceLifetime } from './audio-resource-lifetime';
import { resolveVibeCutoverOnEdge } from './vibe-switch-view';
import { BufferDecks, bufferTransportFlagEnabled } from './buffer-decks';
import { bindDeckLifecycle, handleDeckEnded, type DeckLifecyclePorts } from './deck-lifecycle';
import { DeckSources } from './deck-sources';
import { EdgeTransitions } from './edge-transitions';
import {
  bindMediaSessionActions,
  publishMediaSessionPosition,
  setMediaSessionMetadata,
  setMediaSessionPlaybackState,
} from './media-session';
import {
  loudnessOf,
  type BlendEdgeEventDetail,
  type PlayableTrack,
  type QueueTarget,
} from './playable-track';
import { adoptPrimedPlayerEngine } from './autoplay-arm';
import { rejectedPlayFallbackStatus, snapshotPlayerStatus, toggleIntent } from './player-status';
import { PlaybackTraversal, type ShuffleTransition } from './playback-traversal';
import {
  initialPlaybackControllerState,
  type PlaybackSample,
  type PlayerControllerSource,
  type PlayerStatus,
  type PlaybackControllerApi,
  type PlaybackControllerInit,
  type PlaybackControllerState,
} from './playback-controller-api';
import { useActionNotice } from './use-action-notice';
import { patchLeavesStateUnchanged } from './state-patch';
import { usePlaybackSourceQueue, type PlaybackSourceSnapshot } from './use-playback-source-queue';
import { usePlaybackSettings } from './use-playback-settings';
import { useRepeatOne, type RepeatOneDeps } from './use-repeat-one';
import { useSectionLoop, type SectionLoopDeps } from './use-section-loop';
import { useTrackActions } from './use-track-actions';
import { SERVER_TRACK_MEDIA } from './track-media';

// Re-exported for consumers that type against the controller's surface (e2e
// declarations, Now Playing components).
export type { BlendEdgeEventDetail, PlayableTrack } from './playable-track';
export type {
  PlaybackSample,
  PlayerStatus,
  PlaybackControllerApi,
  PlaybackControllerState,
} from './playback-controller-api';

const POSITION_REPORT_MS = 5000;
function clampVolume(volume: number): number {
  return Math.min(1, Math.max(0, volume));
}
// Back past this position restarts the current track instead of stepping to the
// previous one (the universal player idiom — double-tap to actually go back).
const BACK_RESTART_SECONDS = 3;

/** `navigator.deviceMemory` where the browser reports it. */
function reportedDeviceMemoryGb(): number | null {
  if (typeof navigator === 'undefined') return null;
  const { deviceMemory } = navigator as Navigator & { deviceMemory?: number };
  return typeof deviceMemory === 'number' ? deviceMemory : null;
}

/** The sources a Track's deck load walks — what a failure condemns. */
function sourceKeyOf(track: PlayableTrack): string {
  return `${track.assets.final ?? ''}|${track.assets.stream ?? ''}`;
}

export function usePlaybackController(
  source: PlayerControllerSource,
  initial?: PlaybackControllerInit,
): PlaybackControllerApi {
  // Null for a Playlist source: no queue polling, no playback reports, no
  // loop lease, no Skip feedback — the non-generative Playback source
  // borrows the transport and nothing else.
  const sessionId = source.kind === 'session' ? source.sessionId : null;
  const sourceKind = source.kind;
  const offline = source.kind === 'playlist' && source.offline === true;
  const deckARef = useRef<HTMLAudioElement | null>(null);
  const deckBRef = useRef<HTMLAudioElement | null>(null);
  const engineRef = useRef<PlayerEngine | null>(null);
  const clientId = useClientId();

  // Playback bookkeeping in refs (handlers/intervals must not read stale React state).
  // The playable projection of the Session Queue. Queue membership and normal
  // order are authoritative; alternate traversal modes remain client-local.
  const queueRef = useRef<PlayableTrack[]>([]);
  const idxRef = useRef<number>(0);
  // Whether the stored resume position has been applied to `idxRef` yet — done once,
  // on the first non-empty queue load, so later polls never yank playback backwards.
  const startIndexAppliedRef = useRef<boolean>(false);
  const activeDeckRef = useRef<DeckId>('a');
  // The track each deck currently carries, so a deck that fires `ended` reports for
  // ITS OWN track — not the (already-swapped) active deck during a crossfade. A
  // PREPARED deck carries no track until the handoff commits.
  const deckTrackRef = useRef<Record<DeckId, PlayableTrack | null>>({ a: null, b: null });
  // Each deck's pinned source-ladder walk (committed kind = source commit) —
  // owned by DeckSources; constructed once, reads elements live.
  const deckSourcesRef = useRef<DeckSources | null>(null);
  // The buffer transport (decoded finals through AudioBufferSourceNodes);
  // its natural-end callback reaches the lifecycle semantics through this ref.
  const bufferDecksRef = useRef<BufferDecks | null>(null);
  const lifecyclePortsRef = useRef<DeckLifecyclePorts | null>(null);
  // Unbind for the AudioContext interruption recovery (bound on engine attach).
  const recoveryUnbindRef = useRef<(() => void) | null>(null);
  const audioResourceLifetimeRef = useRef<AudioResourceLifetime | null>(null);
  if (!audioResourceLifetimeRef.current) {
    audioResourceLifetimeRef.current = new AudioResourceLifetime(() => {
      deckSourcesRef.current?.dispose();
      bufferDecksRef.current?.dispose();
      bufferDecksRef.current = null;
      recoveryUnbindRef.current?.();
      recoveryUnbindRef.current = null;
      engineRef.current?.dispose();
      engineRef.current = null;
    });
  }
  // Owner playback settings (defaults until the fetch SETTLES — see the hook).
  const {
    settingsRef,
    settledRef: settingsSettledRef,
    blendEnabled,
    blendSettled,
    setBlendEnabled,
  } = usePlaybackSettings({ read: !offline });
  // The repeat-one loop coordinator: pin state machine, acknowledged
  // generation-hold lease, seam-length math, and queue-snapshot invalidations.
  // Its deps ref is assigned at the END of this hook body (every render), so
  // its callbacks may read anything defined below — it reads only at event
  // time. Destructured because every function is referentially STABLE while
  // `loopHeld` is React state — the deck-lifecycle effect below must never
  // depend on an identity that changes when the lease ack lands (its cleanup
  // disposes the live audio engine).
  const repeatOneDepsRef = useRef<RepeatOneDeps | null>(null);
  const {
    held: loopHeld,
    pinned: loopPinned,
    apply: applyLoopEvent,
    renew: renewLoopLease,
    holdLease,
    seamTarget: loopSeamTarget,
    restartTarget: loopRestartTarget,
    effectiveCrossfadeSeconds,
    onQueueSnapshot: onLoopQueueSnapshot,
  } = useRepeatOne(sessionId, clientId, repeatOneDepsRef);
  // The Section loop, wired the same way: its deps ref is assigned at the END of
  // this hook body and read only at event time.
  const sectionLoopDepsRef = useRef<SectionLoopDeps | null>(null);
  const {
    region: sectionLoopRegion,
    toggleTool: toggleSectionLoopTool,
    setRegion: setSectionLoop,
    clearRegion: clearSectionLoop,
    onTrackChanged: onSectionLoopTrackChanged,
    onDeckEnteredElement: onSectionLoopDeckEnteredElement,
    onQueueSnapshot: onSectionLoopQueueSnapshot,
  } = useSectionLoop(sectionLoopDepsRef);
  // Watched as a TRANSITION, so looping an old-vibe Track that is legitimately
  // still playing after a Change Vibe stays possible.
  const styleRevisionRef = useRef<number | null>(null);
  // Queue items optimistically removed by this controller are suppressed from
  // stale in-flight poll responses until their write settles.
  const locallyRemovedRef = useRef<Set<string>>(new Set());
  // Queue items whose audio failed since the last confirmed start, each keyed
  // to the sources that failed: the failure advance passes over them so dead
  // audio is never re-requested in a loop, and a Track whose sources changed
  // since is worth trying again.
  const deadSourcesRef = useRef<Map<string, string>>(new Map());
  const playbackTraversalRef = useRef(new PlaybackTraversal());
  // Armed at mount for a session the user just started: the
  // start-session click is the play intent, so the first playable track
  // auto-starts from the queue poll. Pause disarms; a rejected play falls
  // back through `rejectedPlayFallbackStatus`.
  const wantPlayRef = useRef<boolean>(initial?.autoplay ?? false);
  const statusRef = useRef<PlayerStatus>('loading');
  // The previous poll's armed-switch flag: the cutover triggers on its falling
  // edge (armed → cleared), exactly once per switch-now Change Vibe.
  const switchPendingRef = useRef(false);
  // Kept in a ref (refreshed each render) so metadata publishing — invoked from
  // stable playback handlers — always reads the current Name.
  const sourceTitleRef = useRef<string | null>(initial?.sourceTitle ?? null);
  sourceTitleRef.current = initial?.sourceTitle ?? null;
  const artworkRef = useRef(initial?.artwork ?? SERVER_TRACK_MEDIA.artwork);
  artworkRef.current = initial?.artwork ?? SERVER_TRACK_MEDIA.artwork;
  // The Session Cover is canonical artwork for every track (Session-level album
  // art). Seeded from the mount summary; each queue poll refreshes it, so the
  // async generated cover replaces the placeholder mid-session.
  const sessionCoverRef = useRef<string | null>(initial?.coverImageId ?? null);
  const [state, setState] = useState<PlaybackControllerState>(() =>
    initialPlaybackControllerState(initial),
  );

  const patch = useCallback((next: Partial<PlaybackControllerState>) => {
    if (next.status) statusRef.current = next.status;
    setState((s) => ({ ...s, ...next }));
  }, []);

  const deckEl = useCallback(
    (deck: DeckId): HTMLAudioElement | null => (deck === 'a' ? deckARef.current : deckBRef.current),
    [],
  );

  // The controller's whole output level (the cross-session handoff's fade
  // handle). A pending host arming behind an audible session mounts at 0.
  const outputVolumeRef = useRef<number>(clampVolume(initial?.initialOutputVolume ?? 1));
  // Whether this controller owns the global Media Session — exactly one of
  // the provider's hosts (the visible entry) may. Re-read live every render.
  const mediaSessionEnabled = initial?.mediaSessionEnabled ?? true;
  const mediaSessionEnabledRef = useRef(mediaSessionEnabled);
  mediaSessionEnabledRef.current = mediaSessionEnabled;

  /** Apply the held output level: through the master bus gain when a graph
   * exists (elements then stay at unity — their samples route through it),
   * through element volume on the sequential fallback. */
  const applyOutputVolume = useCallback(() => {
    const volume = outputVolumeRef.current;
    const graphApplied = engineRef.current?.setMasterGain(volume) ?? false;
    for (const deck of ['a', 'b'] as const) {
      const el = deckEl(deck);
      if (el) el.volume = graphApplied ? 1 : volume;
    }
  }, [deckEl]);

  const setOutputVolume = useCallback(
    (volume: number) => {
      const clamped = clampVolume(volume);
      if (outputVolumeRef.current === clamped) return;
      outputVolumeRef.current = clamped;
      applyOutputVolume();
    },
    [applyOutputVolume],
  );

  // Personal-analytics metering rides beside the playback reports
  // and shares nothing with them: no Session field, Buffer gate, or transport
  // decision reads it. Zero output volume is the app's own silence (a pending
  // host, the far end of a cross-Session fade); the device's volume is not ours
  // to know.
  // A Section loop can land its wrapped position on the same value at two
  // observations, so advancing is read off the context clock while one runs.
  const listeningMeter = useListeningMeter(state.status === 'playing', () => ({
    position: sectionLoopRegion()
      ? (engineRef.current?.now() ?? null)
      : positionOf(activeDeckRef.current),
    audible: outputVolumeRef.current > 0,
  }));
  // Origin evidence for the next `started`: set by the transport actions that
  // choose a Track (Back, a Queue tap), consumed by the start they cause. Skip
  // rejects the current Track and chooses nothing, so what follows is passive. A
  // Track playing out clears it, so an action that started nothing cannot claim
  // a later advance.
  const userStartRef = useRef(false);
  // Set by a Queue tap, consumed by the start it causes: a tapped slot is the
  // listener's own pick, never Shuffle traversal, even while Shuffle is on.
  const queueTapStartRef = useRef(false);
  // A blend handoff starts the incoming Track while the outgoing one is still
  // sounding; its own `ended` follows when the tail runs out.
  const overlapStartMsRef = useRef(0);

  const report = useCallback(
    (
      type: PlaybackReportType,
      track: PlayableTrack | null,
      positionSeconds: number | null,
      queueWrapped = false,
    ) => {
      // Every `started` is one listening occurrence — a loop's replay included;
      // a resume from pause, a seek, and a source-ladder step report no `started`
      // and so continue the open one. Metered on either Playback source: it
      // shares nothing with the gate below. Listening offline is not recorded.
      if (track && !offline) {
        if (type === 'started') {
          listeningMeter().begin(
            { trackId: track.trackId, sessionId, surface: sourceKind },
            {
              origin: userStartRef.current ? 'user' : 'auto',
              overlapMs: overlapStartMsRef.current,
            },
          );
          userStartRef.current = false;
        } else if (type === 'ended') {
          listeningMeter().close(track.trackId, 'ended');
          userStartRef.current = false;
          queueTapStartRef.current = false;
        } else if (type === 'skipped') listeningMeter().close(track.trackId, 'navigated');
        else if (type === 'failed') listeningMeter().close(track.trackId, 'failed');
      }
      // Shuffle's order is client-only: the server must not read a later slot's
      // start as proof that earlier slots Shuffle has not reached were skipped.
      const shuffled =
        type === 'started' &&
        playbackTraversalRef.current.mode === 'shuffle' &&
        !queueTapStartRef.current;
      if (type === 'started') queueTapStartRef.current = false;
      // A Playlist sends no playback report: those are the Session top-up
      // gate, and playing a Playlist must leave the Active Session idle.
      if (!sessionId) return;
      reportPlayback({
        sessionId,
        clientId,
        clientEventId: makeUuid(),
        type,
        queueItemId: track?.queueItemId ?? null,
        trackId: track?.trackId ?? null,
        positionSeconds,
        clientTimestamp: new Date().toISOString(),
        ...(queueWrapped ? { queueWrapped: true } : {}),
        ...(shuffled ? { shuffled: true } : {}),
      });
    },
    [sessionId, sourceKind, offline, clientId, listeningMeter],
  );

  const setMediaMetadata = useCallback((track: PlayableTrack) => {
    if (!mediaSessionEnabledRef.current) return;
    setMediaSessionMetadata(
      track,
      { title: sourceTitleRef.current, coverImageId: sessionCoverRef.current },
      artworkRef.current,
    );
  }, []);

  // Create + attach the Web Audio graph exactly once, lazily, on the first play gesture.
  // Building it in a mount effect would double-run under React StrictMode and a second
  // `createMediaElementSource` on the same <audio> throws — leaving the element muted.
  // Deferring to the first gesture sidesteps that entirely.
  const ensureEngine = useCallback((): PlayerEngine | null => {
    if (engineRef.current) return engineRef.current;
    const a = deckARef.current;
    const b = deckBRef.current;
    if (!a || !b) return null;
    // A start-session gesture may have primed an engine (context created +
    // unlocked inside that click); adopt it so the poll-driven
    // auto-start rides its activation.
    const engine = adoptPrimedPlayerEngine() ?? new PlayerEngine();
    engine.attach(a, b);
    engineRef.current = engine;
    // The graph carries the output level from here on; the elements return
    // to unity so the two paths never attenuate twice.
    applyOutputVolume();
    // Suspension/interruption recovery (phone call, route change, background
    // eviction): resume whenever the user still wants playback.
    recoveryUnbindRef.current = engine.bindInterruptionRecovery(() => wantPlayRef.current);
    return engine;
  }, [applyOutputVolume]);

  /** The buffer transport (constructed once, lazily). Its natural-end mirrors
   * the element `ended` semantics through the shared lifecycle handler. */
  const bufferDecks = useCallback((): BufferDecks => {
    bufferDecksRef.current ??= new BufferDecks(
      () => engineRef.current,
      (deck, positionSeconds) => {
        const ports = lifecyclePortsRef.current;
        if (ports) handleDeckEnded(ports, deck, positionSeconds);
      },
      storedTrackAudio,
    );
    return bufferDecksRef.current;
  }, []);

  /** Whether the live blend runs at all: a real graph AND the settled owner
   * setting. When false the player is strictly sequential — advance on `ended`,
   * one audible deck, never an early-started incoming element. */
  const blendActive = useCallback(
    (): boolean =>
      Boolean(engineRef.current?.isActive) &&
      settingsSettledRef.current &&
      settingsRef.current.blendEnabled,
    [],
  );

  /** Session-level buffer-transport qualification:
   * the internal flag, a decodable context, and `navigator.deviceMemory ≥ 4` —
   * a missing API is safe-off (element decks, no UA sniffing). */
  const bufferEligible = useCallback((): boolean => {
    return (
      blendActive() &&
      bufferTransportEligible({
        flagEnabled: bufferTransportFlagEnabled(),
        decodeSupported: bufferDecks().supported(),
        deviceMemoryGb: reportedDeviceMemoryGb(),
      })
    );
  }, [blendActive, bufferDecks]);

  const deviceAllowsSectionLoop = useCallback(
    (): boolean =>
      sectionLoopEligible({
        flagEnabled: bufferTransportFlagEnabled(),
        decodeSupported: bufferDecks().supported(),
        deviceMemoryGb: reportedDeviceMemoryGb(),
      }),
    [bufferDecks],
  );

  /** The track the active deck is actually carrying — the audible source of truth
   * every current-track action/report targets (the queue cursor is only
   * navigation and can lag a poll that dropped the active item). */
  const activeTrack = useCallback(
    (): PlayableTrack | null => deckTrackRef.current[activeDeckRef.current],
    [],
  );

  /** The deck's truthful playback sample — the buffer transport's exact
   * context-clock view while it carries the deck, the element's otherwise.
   * One boundary for every consumer (reports, Media Session, Back threshold),
   * so no caller can mix the two clocks. */
  const playbackSampleOf = useCallback(
    (deck: DeckId): PlaybackSample => {
      const buffers = bufferDecks();
      if (buffers.carrying(deck)) {
        return {
          positionSeconds: buffers.positionSeconds(deck),
          durationSeconds: buffers.durationSeconds(deck),
          playbackRate: buffers.playbackRate(deck),
        };
      }
      const el = deckEl(deck);
      return {
        positionSeconds: el?.currentTime ?? null,
        durationSeconds: el && Number.isFinite(el.duration) ? el.duration : null,
        playbackRate: el?.playbackRate ?? 1,
      };
    },
    [bufferDecks, deckEl],
  );

  const positionOf = useCallback(
    (deck: DeckId): number | null => playbackSampleOf(deck).positionSeconds,
    [playbackSampleOf],
  );

  /** The UI-facing sample of the ACTIVE deck — the progress slider's polling
   * read (position stays out of render state by design). */
  const getPlaybackSample = useCallback(
    (): PlaybackSample => playbackSampleOf(activeDeckRef.current),
    [playbackSampleOf],
  );

  /** Publish the lock-screen position from the truthful clock (the context
   * clock during buffer playback — never the muted carrier element). A
   * caller holding a BETTER sample than a live read would produce passes it
   * explicitly — the seek funnel during the pre-metadata window: the element
   * cannot answer yet, but the queue metadata resolved the clamp, and the OS
   * slider must land at the target instead of clearing. */
  const publishPositionState = useCallback(
    (sample?: PlaybackSample) => {
      if (!mediaSessionEnabledRef.current) return;
      publishMediaSessionPosition(
        mediaSessionPositionState(sample ?? playbackSampleOf(activeDeckRef.current)),
      );
    },
    [playbackSampleOf],
  );

  /** Best-effort re-sync of the deck's muted carrier element to its buffer
   * clock (focus/lock-screen truth — the audible audio is the buffer either
   * way). Shared by buffer resume, the carrier watchdog, and the seek funnel. */
  const syncCarrierToBuffer = useCallback(
    (deck: DeckId) => {
      const el = deckEl(deck);
      const position = bufferDecks().positionSeconds(deck);
      if (el && position != null && Number.isFinite(el.duration)) {
        el.currentTime = Math.min(position, el.duration);
      }
    },
    [bufferDecks, deckEl],
  );

  const deckSources = useCallback((): DeckSources => {
    deckSourcesRef.current ??= new DeckSources(deckEl, storedTrackAudio);
    return deckSourcesRef.current;
  }, [deckEl]);

  /** The render-state source kind committed by a deck's pinned URL ladder. */
  const committedSourcePatch = useCallback(
    (deck: DeckId): Pick<PlaybackControllerState, 'sourceKind'> => ({
      sourceKind: deckSources().committedKind(deck),
    }),
    [deckSources],
  );

  /** Return a deck to the element path before (re)loading it: any buffer
   * playback stops deliberately and the media gate reopens. */
  const enterElementMode = useCallback(
    (deck: DeckId) => {
      onSectionLoopDeckEnteredElement(deck);
      bufferDecks().stop(deck);
      engineRef.current?.setDeckMediaAudible(deck, true);
    },
    [bufferDecks, onSectionLoopDeckEnteredElement],
  );

  /** Stop + unload a deck (buffer source, gate, element, ladder, track ref). */
  const unloadDeck = useCallback(
    (deck: DeckId) => {
      enterElementMode(deck);
      deckSources().unload(deck);
      deckTrackRef.current[deck] = null;
    },
    [deckSources, enterElementMode],
  );

  /** The index navigation should try next: past the audible track when it still sits
   * at the cursor, the cursor slot itself when it vanished from the projection
   * (later items shifted left into it) or when nothing is loaded. */
  const nextIndex = useCallback(
    (): number =>
      nextPlaylistIndex(queueRef.current, activeTrack()?.queueItemId ?? null, idxRef.current),
    [activeTrack],
  );

  const explicitNextTarget = useCallback(
    (skip?: (track: PlayableTrack) => boolean): QueueTarget | null => {
      const next = nextIndex();
      const start = resolveOrderedNextIndex(queueRef.current.length, next - 1) ?? 0;
      const target = playbackTraversalRef.current.next(
        queueRef.current,
        activeTrack()?.queueItemId ?? null,
        start,
        skip,
      );
      // An ordered advance past the projection's end is the Queue loop restarting;
      // the target carries that so its `started` report can prove the wrap to the
      // server. Shuffle traversal owns its own ordering (the bag) and never wraps.
      if (
        target &&
        playbackTraversalRef.current.mode !== 'shuffle' &&
        (next >= queueRef.current.length || target.idx < start)
      ) {
        return { ...target, wrapped: true };
      }
      return target;
    },
    [activeTrack, nextIndex],
  );

  const isDeadSource = useCallback(
    (track: PlayableTrack) => deadSourcesRef.current.get(track.queueItemId) === sourceKeyOf(track),
    [],
  );

  /** The transition target: the loop pin (repeat-one wins while set — the seam
   * is an ordinary edge whose target is the pinned track itself; a pinned
   * track too short for the minimum quantized fade prepares NOTHING and
   * replays via the natural-end restart in `advance`), the next queue slot,
   * the next mode-selected queue slot. */
  const resolveNextTarget = useCallback((): QueueTarget | null => {
    if (sectionLoopRegion()) return null;
    if (loopPinned()) return loopSeamTarget();
    if (playbackTraversalRef.current.mode === 'loop-track') {
      return null;
    }
    return explicitNextTarget();
  }, [explicitNextTarget, loopPinned, loopSeamTarget, sectionLoopRegion]);

  /** Arm Loop Track's seamless pin once `deck` commits a downloaded final (the
   * pin is restricted to finals). A no-op outside Loop Track, before a final
   * commits, or while a pin is already live. */
  const armLoopTrackPin = useCallback(
    (deck: DeckId, track: PlayableTrack | null) => {
      if (
        playbackTraversalRef.current.mode === 'loop-track' &&
        track &&
        !loopPinned() &&
        deckSources().committedKind(deck) === 'final'
      ) {
        applyLoopEvent({
          type: 'toggle-on',
          track: { queueItemId: track.queueItemId, trackId: track.trackId },
        });
      }
    },
    [applyLoopEvent, deckSources, loopPinned],
  );

  /** The logical handoff of a blend transition (the driver calls this at the
   * fade boundary): the incoming deck becomes the audible current track and the
   * `started` report + cursor + metadata land now. */
  const commitHandoff = useCallback(
    (deck: DeckId, track: PlayableTrack, idx: number, queueWrapped = false) => {
      const outgoing = activeTrack();
      playbackTraversalRef.current.commit(outgoing?.queueItemId ?? null, track.queueItemId);
      deckTrackRef.current[deck] = track;
      activeDeckRef.current = deck;
      idxRef.current = idx;
      // The loop pin reacts to what became current BEFORE the next-target
      // reads below: a seam replay keeps the pin and a different track ends it,
      // so `retainOnly` sees the post-pin truth.
      applyLoopEvent({ type: 'committed', queueItemId: track.queueItemId });
      armLoopTrackPin(deck, track);
      // The REAL playback position (buffer clock or element): an aligned
      // pre-roll has already advanced past zero — a Stop right after the
      // handoff must resume there, not replay it.
      overlapStartMsRef.current = outgoing ? effectiveCrossfadeSeconds() * 1000 : 0;
      report('started', track, positionOf(deck) ?? 0, queueWrapped);
      overlapStartMsRef.current = 0;
      setMediaMetadata(track);
      publishPositionState();
      // Hold at most current + next decoded finals; release on advance.
      bufferDecks().retainOnly([track.trackId, resolveNextTarget()?.track.trackId]);
      patch({
        currentTrack: track,
        currentFavorited: track.favoritedAt != null,
        currentInCuratedPlaylist: track.inCuratedPlaylist,
        status: 'playing',
        playIntentPending: false,
        ...committedSourcePatch(deck),
      });
    },
    [
      applyLoopEvent,
      activeTrack,
      armLoopTrackPin,
      bufferDecks,
      committedSourcePatch,
      patch,
      positionOf,
      publishPositionState,
      report,
      resolveNextTarget,
      setMediaMetadata,
    ],
  );

  // The prepared-deck transition driver. Constructed once; every host method
  // reads the CURRENT refs/callbacks at call time (all are stable).
  const transitionsRef = useRef<EdgeTransitions | null>(null);
  const transitions = useCallback((): EdgeTransitions => {
    transitionsRef.current ??= new EdgeTransitions({
      deckEl: (deck) => deckEl(deck),
      engine: () => engineRef.current,
      // The loop seam shortens the effective crossfade to its overlap; every
      // other edge sees the owner setting unchanged.
      settings: () => ({
        ...settingsRef.current,
        crossfadeSeconds: effectiveCrossfadeSeconds(),
      }),
      activeDeck: () => activeDeckRef.current,
      deckTrack: (deck) => deckTrackRef.current[deck],
      committedKind: (deck) => deckSources().committedKind(deck),
      // Every element (re)load leaves buffer mode first: the ladder walk must
      // be audible unless a buffer edge explicitly gates it again.
      loadDeck: (deck, track) => {
        enterElementMode(deck);
        return deckSources().begin(deck, track);
      },
      unloadDeck: (deck) => unloadDeck(deck),
      nextTarget: () => resolveNextTarget(),
      commit: (deck, track, idx, queueWrapped) => commitHandoff(deck, track, idx, queueWrapped),
      buffers: () => bufferDecks(),
      bufferEligible: () => bufferEligible(),
    });
    return transitionsRef.current;
  }, [
    bufferDecks,
    bufferEligible,
    commitHandoff,
    deckEl,
    deckSources,
    effectiveCrossfadeSeconds,
    enterElementMode,
    resolveNextTarget,
    unloadDeck,
  ]);

  /** Play `el` and patch `playing` only once the play promise RESOLVES — a rejected
   * play (iOS autoplay/interruption policy, aborted load) leaves the UI paused
   * instead of claiming playback that never started. Both settle handlers
   * re-check that the deck is still active and still carries this track, so a
   * late settle after an advance/hard-cut can never patch a stale status.
   * `reportStart` reports `started` at the actual playback start, never at load. */
  const playAndConfirm = useCallback(
    (
      deck: DeckId,
      el: HTMLAudioElement,
      track: PlayableTrack,
      reportStart: boolean,
      queueWrapped = false,
    ) => {
      const stillCurrent = () =>
        activeDeckRef.current === deck && deckTrackRef.current[deck] === track;
      const attempt = (src: string): Promise<void> =>
        el.play().then(
          () => {
            if (stillCurrent() && !el.paused) {
              // Every navigation that starts audio (Skip, Back, swipe, Reroll)
              // lands here, so the play intent follows what is audible.
              wantPlayRef.current = true;
              deadSourcesRef.current.clear();
              patch({ status: 'playing', playIntentPending: false });
              if (reportStart) report('started', track, el.currentTime, queueWrapped);
            }
          },
          () => {
            if (!stillCurrent()) return;
            // A ladder step-down reloaded the element and re-played it, which
            // rejects this play(): the re-play owns the outcome, and a fresh
            // start still owes its `started` report once it is audible.
            if (el.src !== src) {
              if (reportStart && wantPlayRef.current) attempt(el.src);
              return;
            }
            // A blocked FRESH start (reportStart — including the auto-start) lands
            // in `ready`: a live Play button, never a stuck
            // spinner or a phantom pause. A blocked resume keeps `paused`.
            wantPlayRef.current = false;
            patch({
              status: rejectedPlayFallbackStatus(reportStart),
              playIntentPending: false,
            });
          },
        );
      attempt(el.src);
    },
    [patch, report],
  );

  /** Load `track` onto `deck` and hard-cut into it at its solo loudness (one
   * atomic engine call — a separate gain step would be cancelled by the cut). */
  const cutOverTo = useCallback(
    (deck: DeckId, track: PlayableTrack, queueWrapped = false) => {
      const el = deckEl(deck);
      const engine = ensureEngine();
      if (!el) return false;
      // Explicit navigation is always an ELEMENT load boundary: a
      // buffer playing on this deck stops deliberately, the gate reopens, and
      // the pinned ladder re-runs. The buffer tier re-enters at the next
      // qualifying edge via the mixed bootstrap.
      enterElementMode(deck);
      if (!deckSources().begin(deck, track)) return false;
      el.playbackRate = 1;
      playAndConfirm(deck, el, track, true, queueWrapped);
      engine?.hardCut(deck, soloLoudnessGainDb(loudnessOf(track)));
      // A hard cut is not an edge, and the fresh ladder walk has no committed
      // source yet: clear the tier readout AND the committed-source state here
      // in the one hard-cut primitive (every navigation path funnels through),
      // so no caller can keep claiming the previous source or blend tier.
      patch({ activeEdgeTier: null, ...committedSourcePatch(deck) });
      return true;
    },
    [
      committedSourcePatch,
      deckEl,
      deckSources,
      ensureEngine,
      enterElementMode,
      patch,
      playAndConfirm,
    ],
  );

  /** Load track `idx` onto `deck` and hard-cut into it (explicit navigation and the
   * cold-start entry; blend transitions go through the prepared-deck driver instead). */
  const playOnDeck = useCallback(
    (
      deck: DeckId,
      idx: number,
      shuffleTransition: ShuffleTransition = 'record',
      queueWrapped = false,
    ) => {
      const track = queueRef.current[idx];
      if (!track) return;

      transitions().cancel();
      const previousDeck = activeDeckRef.current;
      if (!cutOverTo(deck, track, queueWrapped)) return;

      playbackTraversalRef.current.commit(
        activeTrack()?.queueItemId ?? null,
        track.queueItemId,
        shuffleTransition,
      );

      // A hard cut abandons the deck we're leaving; stop it and forget its track
      // so its later `ended` can't report a spurious play.
      if (previousDeck !== deck) unloadDeck(previousDeck);

      deckTrackRef.current[deck] = track;
      activeDeckRef.current = deck;
      idxRef.current = idx;
      // A cut-over to a DIFFERENT track ends a loop pin (Back to previous, the
      // failure path); replaying the pinned track (loop restart, Back-restart)
      // keeps it. The fresh load has no committed source yet — the toggle
      // re-enables when the pinned final commits (`onSourceCommitted`).
      applyLoopEvent({ type: 'committed', queueItemId: track.queueItemId });
      setMediaMetadata(track);
      // Hard-cut navigation advances the current track too: trim the decode
      // cache to current + next NOW, not at the next queue poll (Skip/Back/
      // sequential advance must never let three decoded finals accumulate).
      bufferDecks().retainOnly([track.trackId, resolveNextTarget()?.track.trackId]);
      // `status: 'playing'` + the `started` report land in `playAndConfirm` once
      // playback actually starts; the track identity is current the moment the
      // deck carries it.
      // `cutOverTo` cleared committed-source state; source commit restores the
      // badge and can upgrade Loop Track to its seamless pin.
      patch({
        currentTrack: track,
        currentFavorited: track.favoritedAt != null,
        currentInCuratedPlaylist: track.inCuratedPlaylist,
      });
    },
    [
      activeTrack,
      bufferDecks,
      cutOverTo,
      patch,
      resolveNextTarget,
      setMediaMetadata,
      transitions,
      unloadDeck,
    ],
  );

  /** Stop and wait with the cursor parked on `idx`: the slot resume starts from. */
  const waitAt = useCallback(
    (idx: number) => {
      // Silence BOTH decks — the active one still carries the old (ended, skipped,
      // disliked, or failed) track, and mid-crossfade the OUTGOING deck is still
      // audibly fading (e.g. the incoming source errored with nothing next) —
      // "Preparing" must never keep either audible. Clearing the outgoing deck also
      // skips its late `ended` report; that's fine — the incoming track's `started`
      // already closed its queue slot, and truthful silence wins.
      transitions().cancel();
      unloadDeck('a');
      unloadDeck('b');
      idxRef.current = Math.min(idx, queueRef.current.length);
      patch({
        status: 'waiting',
        playIntentPending: wantPlayRef.current,
        currentTrack: null,
        currentFavorited: false,
        currentInCuratedPlaylist: false,
        sourceKind: null,
        activeEdgeTier: null,
      });
    },
    [patch, transitions, unloadDeck],
  );

  /** Play `idx` on the other deck, or stop and wait when no playable target exists. */
  const playIndexOrWait = useCallback(
    (idx: number, shuffleTransition: ShuffleTransition = 'record', queueWrapped = false) => {
      const other: DeckId = activeDeckRef.current === 'a' ? 'b' : 'a';
      if (queueRef.current[idx]) {
        playOnDeck(other, idx, shuffleTransition, queueWrapped);
      } else {
        // Queue exhausted: park the cursor on the slot the next arriving track
        // fills, so resume starts there instead of replaying or skipping past it.
        waitAt(idx);
      }
    },
    [playOnDeck, waitAt],
  );

  /** Natural advance to the next track (sequential hard cut), loop, or wait.
   * A live loop pin re-targets the pinned track itself: the seam normally
   * fires before the end, so reaching here IS the natural-end restart (the
   * too-short track, `blendEnabled: false`, or a failed seam preparation). */
  const advance = useCallback(() => {
    const loop = loopRestartTarget();
    if (loop || playbackTraversalRef.current.mode === 'loop-track') {
      const current = activeTrack();
      const currentIdx = current
        ? queueRef.current.findIndex((track) => track.queueItemId === current.queueItemId)
        : -1;
      playIndexOrWait(loop?.idx ?? (currentIdx >= 0 ? currentIdx : queueRef.current.length));
      return;
    }
    const target = explicitNextTarget();
    playIndexOrWait(target?.idx ?? queueRef.current.length, 'record', target?.wrapped ?? false);
  }, [activeTrack, explicitNextTarget, loopRestartTarget, playIndexOrWait]);

  const setPlaybackMode = useCallback(
    (next: PlaybackMode) => {
      const previous = playbackTraversalRef.current.mode;
      if (next === previous) return;

      if (previous === 'loop-track') applyLoopEvent({ type: 'exit' });
      playbackTraversalRef.current.select(
        next,
        queueRef.current,
        activeTrack()?.queueItemId ?? null,
      );

      const current = activeTrack();
      armLoopTrackPin(activeDeckRef.current, current);

      transitions().syncTarget(resolveNextTarget());
      bufferDecks().retainOnly([current?.trackId, resolveNextTarget()?.track.trackId]);
      patch({ playbackMode: next });
    },
    [
      activeTrack,
      applyLoopEvent,
      armLoopTrackPin,
      bufferDecks,
      patch,
      resolveNextTarget,
      transitions,
    ],
  );

  const cyclePlaybackMode = useCallback(() => {
    setPlaybackMode(playbackTraversalRef.current.nextMode());
  }, [setPlaybackMode]);

  const play = useCallback(() => {
    wantPlayRef.current = true;
    patch({ playIntentPending: true });
    void ensureEngine()?.resume();
    const deck = activeDeckRef.current;
    const el = deckEl(deck);
    const track = deckTrackRef.current[deck];
    // Resume only while the active deck carries a live track; after the queue plays
    // out (or a dislike empties it) the deck is stopped and its leftover src must not
    // be resumable — start whatever the cursor points at instead.
    if (el && track) {
      const buffers = bufferDecks();
      if (buffers.state(deck) === 'paused') {
        // Buffer resume: recreate the source at the recorded offset, re-sync
        // the muted carrier, keep it rolling for focus (best-effort — the
        // audible audio is the buffer either way).
        const resumed = buffers.resume(deck);
        // Either way the element seeks to the recorded offset: the carrier
        // re-syncs on success, and the ELEMENT-PATH FALLBACK must resume at
        // the same position — never restart from the carrier's stale time
        // (a failed resume rolls back to `paused`, so the offset survives).
        syncCarrierToBuffer(deck);
        if (resumed) {
          void el.play().catch(() => undefined);
          publishPositionState();
          patch({ status: 'playing', playIntentPending: false });
          return;
        }
        // The context is gone: fall back to the element path truthfully.
        enterElementMode(deck);
      }
      playAndConfirm(deck, el, track, false);
      return;
    }
    if (queueRef.current[idxRef.current]) {
      playOnDeck(deck, idxRef.current);
      return;
    }
    // Nothing buffered to start. Playback reports are what mark the session as
    // "someone is listening" for the worker's playback-gated buffer controller —
    // a trackless position ping records the intent so the next sweep tops the
    // buffer up; the queue poll then auto-starts the first arriving track.
    report('position', null, null);
  }, [
    bufferDecks,
    deckEl,
    ensureEngine,
    enterElementMode,
    patch,
    playAndConfirm,
    playOnDeck,
    publishPositionState,
    report,
    syncCarrierToBuffer,
  ]);

  /** Close out any NON-active deck still fading its tail and settle the graph
   * onto the active deck at ITS solo gain (the armed post-fade settle
   * automation dies with the hold inside the hard cut). Shared by `pause` and
   * `seekTo` — both abandon a running fade the same way (the context clock
   * keeps running, so the tail's fade would complete while paused/re-posed
   * and leave the deck stranded, blocking every later preparation). The
   * contract is explicit about the element because `pause()` gets it for free
   * and a seek does not: report `ended` for the deck's track, PAUSE that
   * deck's element (a no-op under `pause()`, which already paused every
   * element; essential under `seekTo`, which must not pause the active one),
   * stop its buffer source, clear its track ref and ladder. It does NOT
   * unload the element's source (pause parity) — the cleared ladder is what
   * makes the deck reusable for the next preparation. */
  const settleToActiveDeck = useCallback(() => {
    for (const deck of ['a', 'b'] as const) {
      if (deck === activeDeckRef.current) continue;
      const track = deckTrackRef.current[deck];
      if (!track) continue;
      report('ended', track, positionOf(deck));
      deckEl(deck)?.pause();
      bufferDecks().stop(deck);
      deckTrackRef.current[deck] = null;
      deckSources().clear(deck);
      engineRef.current?.hardCut(
        activeDeckRef.current,
        soloLoudnessGainDb(loudnessOf(activeTrack())),
      );
    }
  }, [activeTrack, bufferDecks, deckEl, deckSources, positionOf, report]);

  const pause = useCallback(() => {
    wantPlayRef.current = false;
    // A prepared/armed transition cannot survive a pause: its fade would run
    // against paused elements. Cancel it; resume re-prepares from timeupdate.
    // A live loop pin survives the pause; only its lease can lapse by TTL.
    transitions().cancel();
    applyLoopEvent({ type: 'seam-cancelled' });
    for (const deck of ['a', 'b'] as const) {
      deckEl(deck)?.pause();
    }
    // A buffer-carrying active deck records its exact offset (the source node
    // is one-shot: stop now, recreate at the offset on resume).
    bufferDecks().pause(activeDeckRef.current);
    // A NON-active deck still fading out its tail is abandoned by a pause —
    // close it out truthfully and settle onto the active deck.
    settleToActiveDeck();
    patch({ status: 'paused', playIntentPending: false });
  }, [applyLoopEvent, bufferDecks, deckEl, patch, settleToActiveDeck, transitions]);

  /** Cancel the armed transition, let the loop coordinator see the cancelled
   * seam, and settle a running fade: the fade time is wrong once the position
   * moves. */
  const abandonEdge = useCallback(() => {
    transitions().cancel();
    applyLoopEvent({ type: 'seam-cancelled' });
    settleToActiveDeck();
  }, [applyLoopEvent, settleToActiveDeck, transitions]);

  /** The ONE seek funnel — every seek source (the Media Session
   * `seekto` binding, the progress slider) goes
   * through here. Validation comes BEFORE every side effect: an invalid
   * target (no track, unknown duration, non-finite input) is a complete
   * no-op — no cancellation, no report. A valid seek is pause-shaped with
   * respect to blend edges: it cancels any armed preparation (the scheduled
   * fade time is wrong at the new position; the edge re-arms from timeupdate
   * with whatever runway the target leaves), settles a running fade onto the
   * active deck, writes the transport, and immediately reports + republishes
   * so server-side resume state and the OS slider land with it. */
  const seekTo = useCallback(
    (seconds: number) => {
      const deck = activeDeckRef.current;
      const track = deckTrackRef.current[deck];
      const el = deckEl(deck);
      if (!track || !el) return;
      // Duration resolution: the live sample (buffer duration or finite
      // element duration) outranks the queue metadata; metadata covers the
      // pre-metadata element window. No trustworthy duration → seeking off.
      const sample = playbackSampleOf(deck);
      const durationSeconds = sample.durationSeconds ?? track.durationSeconds ?? null;
      const target = resolveSeekTarget(seconds, durationSeconds);
      if (target == null) return;

      // Pause parity (design decision).
      abandonEdge();
      // A listener seeking away from a Section loop has moved on from it.
      const sectionLoop = sectionLoopRegion();
      if (sectionLoop && (target < sectionLoop.startSeconds || target >= sectionLoop.endSeconds)) {
        clearSectionLoop();
      }

      const buffers = bufferDecks();
      if (buffers.carrying(deck)) {
        if (buffers.seekTo(deck, target)) {
          syncCarrierToBuffer(deck);
        } else {
          // A playing-path source recreation failed: the transport rolled
          // back to `paused` at the target. Fall back to the element path
          // truthfully — never an unmuted-but-silent carrier while the
          // status says `playing` (the same sequence `play()`'s
          // buffer-resume fallback performs).
          enterElementMode(deck);
          el.currentTime = target;
          playAndConfirm(deck, el, track, false);
        }
      } else {
        el.currentTime = target;
      }

      // Keep server-side resume honest without waiting for the 5 s tick, and
      // land the OS slider now instead of letting it drift until then — from
      // the RESOLVED sample, not a live re-read (which, pre-metadata, would
      // publish the clear form instead of the target the seek just landed).
      report('position', track, target);
      publishPositionState({
        positionSeconds: target,
        durationSeconds,
        playbackRate: sample.playbackRate,
      });
    },
    [
      abandonEdge,
      bufferDecks,
      clearSectionLoop,
      deckEl,
      enterElementMode,
      playAndConfirm,
      playbackSampleOf,
      publishPositionState,
      report,
      sectionLoopRegion,
      syncCarrierToBuffer,
    ],
  );

  // The card's ONE transient failure notice, shared by the feedback actions
  // and the loop generation hold.
  const flashActionError = useActionNotice(patch);

  // The in-player blend toggle: the settings hook flips the live gate and
  // persists; a write that did not land surfaces on the shared notice.
  // Turning blends OFF also strikes the edge already in flight — aligned
  // automation arms at readiness, well before the fade start, and would
  // otherwise still crossfade; the cancelled target advances on `ended`
  // instead (and re-prepares if the write fails and the setting reverts).
  const toggleBlend = useCallback(() => {
    const enabled = !settingsRef.current.blendEnabled;
    if (!enabled) transitions().cancel();
    void setBlendEnabled(enabled).then((error) => {
      if (error) flashActionError(error);
    });
  }, [flashActionError, setBlendEnabled, settingsRef, transitions]);

  // The queue poll wake-up, assigned once `usePlaybackSourceQueue` runs below;
  // ref-held so earlier hooks (track actions) can close over it.
  const pollQueueNowRef = useRef<() => void>(() => {});

  const removeFromQueue = useCallback((queueItemId: string) => {
    queueRef.current = queueRef.current.filter((t) => t.queueItemId !== queueItemId);
    playbackTraversalRef.current.remove(queueItemId);
    setState((current) => ({
      ...current,
      queueItems: current.queueItems.filter((item) => item.id !== queueItemId),
      queueLength: queueRef.current.length,
      playableQueueItemIds: queueRef.current.map((track) => track.queueItemId),
    }));
  }, []);

  // A removed track cannot remain pinned or in shuffle history. The mode
  // stays selected and applies to the replacement track.
  const advancePastCurrent = useCallback(() => {
    applyLoopEvent({ type: 'exit' });
    const target = explicitNextTarget();
    playIndexOrWait(target?.idx ?? queueRef.current.length, 'discard', target?.wrapped ?? false);
  }, [applyLoopEvent, explicitNextTarget, playIndexOrWait]);

  // Feedback-loop actions — semantics in use-track-actions.
  const { dislike, deleteTrack, applyRetentionFlags, toggleFavorite, reportSkip } = useTrackActions(
    {
      sessionId,
      activeTrack,
      patch,
      flashActionError,
      queueChanged: () => pollQueueNowRef.current(),
      markRemoved: (queueItemId) => locallyRemovedRef.current.add(queueItemId),
      unmarkRemoved: (queueItemId) => locallyRemovedRef.current.delete(queueItemId),
      removeFromQueue,
      advancePastCurrent,
    },
  );

  /** Delete Track is not feedback: unlike Skip, moving past the
   * deleted Track records neither a `skip` event nor a `skipped` report. A
   * Track that is no longer the audible one leaves playback alone. */
  const advancePastDeletedTrack = useCallback(
    (trackId: string) => {
      const track = activeTrack();
      if (!track || track.trackId !== trackId) return;
      locallyRemovedRef.current.add(track.queueItemId);
      removeFromQueue(track.queueItemId);
      advancePastCurrent();
    },
    [activeTrack, advancePastCurrent, removeFromQueue],
  );

  const skip = useCallback(() => {
    const track = activeTrack();
    if (!track) return;
    // The loop-track mode stays selected, but its pin follows the next track.
    applyLoopEvent({ type: 'exit' });
    report('skipped', track, positionOf(activeDeckRef.current));
    reportSkip(track);
    const target = explicitNextTarget();
    playIndexOrWait(target?.idx ?? queueRef.current.length, 'record', target?.wrapped ?? false);
  }, [
    activeTrack,
    explicitNextTarget,
    playIndexOrWait,
    applyLoopEvent,
    positionOf,
    report,
    reportSkip,
  ]);

  /** Restart the current track. It RE-RUNS the pinned source ladder:
   * a final that landed while the stream was playing is
   * picked up here, making restart a real load boundary rather than a seek to
   * zero — even when the track already left the queue projection (the ladder
   * then optimistically includes the deterministic pinned-final path for the
   * track id; a pinned URL whose asset does not exist 404s and the ladder steps
   * down, so trying it is safe by construction). */
  const restart = useCallback(() => {
    userStartRef.current = true;
    const el = deckEl(activeDeckRef.current);
    const track = activeTrack();
    if (!el || !track) return;
    const idx = queueRef.current.findIndex((t) => t.queueItemId === track.queueItemId);
    if (idx >= 0) {
      playOnDeck(activeDeckRef.current, idx);
      return;
    }
    transitions().cancel();
    // Mutate the HELD object (identity matters: the play-settle guard
    // compares by reference) — optimistically include the deterministic
    // pinned-final path; a pinned URL whose asset doesn't exist 404s and
    // the ladder steps down.
    track.assets = {
      final: track.assets.final ?? `/api/audio/${track.trackId}?asset=final`,
      stream: track.assets.stream,
    };
    if (!cutOverTo(activeDeckRef.current, track)) {
      // A rewind starts no occurrence, so it must not lend its origin to the
      // blend handoff that follows.
      el.currentTime = 0;
      userStartRef.current = false;
    }
  }, [activeTrack, cutOverTo, deckEl, playOnDeck, transitions]);

  /** Step to the previous Track even mid-track — the cover swipe, whose preview
   * shows that Track, so a restart would contradict it. Falls back to a restart
   * when none precedes the cursor — never to silence. */
  const previous = useCallback(() => {
    userStartRef.current = true;
    const traversal = playbackTraversalRef.current;
    if (traversal.mode === 'shuffle') {
      const target = traversal.previous(queueRef.current, activeTrack()?.queueItemId ?? null);
      if (target) playOnDeck(activeDeckRef.current, target.idx, 'preserve');
      else restart();
      return;
    }
    const target = previousPlaylistIndex(queueRef.current, idxRef.current);
    if (target == null) {
      restart();
      return;
    }
    if (traversal.mode === 'loop-track') applyLoopEvent({ type: 'exit' });
    playIndexOrWait(target);
  }, [activeTrack, applyLoopEvent, playIndexOrWait, playOnDeck, restart]);

  /** Back: the universal player idiom. Mid-track it restarts the current track;
   * near the start it steps to the previous Track. Shuffle always steps, since
   * its history is the order being retraced. Unlike Skip this emits NO feedback
   * event and no `skipped` report: going back is re-listening, not rejection
   * (the only negative signals are Skip and Dislike). */
  const back = useCallback(() => {
    // A drawn Section loop is worth keeping: Back returns to its start.
    const sectionLoop = sectionLoopRegion();
    if (sectionLoop) {
      seekTo(sectionLoop.startSeconds);
      return;
    }
    const underway =
      playbackTraversalRef.current.mode !== 'shuffle' &&
      activeTrack() !== null &&
      deckEl(activeDeckRef.current) !== null &&
      (positionOf(activeDeckRef.current) ?? 0) > BACK_RESTART_SECONDS;
    if (underway) restart();
    else previous();
  }, [activeTrack, deckEl, positionOf, previous, restart, sectionLoopRegion, seekTo]);

  /** The Tracks a cover swipe would land on: what Skip plays next and what
   * `previous` returns to. Read on demand — the shuffle peek syncs traversal. */
  const peekNeighbors = useCallback((): {
    next: PlayableTrack | null;
    previous: PlayableTrack | null;
  } => {
    const traversal = playbackTraversalRef.current;
    let previousTrack: PlayableTrack | null = null;
    if (traversal.mode === 'shuffle') {
      const target = traversal.peekPrevious(queueRef.current, activeTrack()?.queueItemId ?? null);
      previousTrack = target?.track ?? null;
    } else {
      const idx = previousPlaylistIndex(queueRef.current, idxRef.current);
      if (idx != null) previousTrack = queueRef.current[idx] ?? null;
    }
    return { next: explicitNextTarget()?.track ?? null, previous: previousTrack };
  }, [activeTrack, explicitNextTarget]);

  const toggle = useCallback(() => {
    // Pause also DISARMS a pending auto-start (armed intent, nothing loaded
    // yet); with a track loaded the button always plays.
    const intent = toggleIntent(
      statusRef.current,
      wantPlayRef.current,
      deckTrackRef.current[activeDeckRef.current] != null,
    );
    if (intent === 'pause') pause();
    else play();
  }, [pause, play]);

  // Deck DOM event lifecycle (deck-lifecycle.ts owns the semantics); the
  // engine — created lazily on a play gesture — is disposed here on unmount.
  useEffect(() => {
    const a = deckARef.current;
    const b = deckBRef.current;
    if (!a || !b) return;
    const releaseAudioResources = audioResourceLifetimeRef.current!.bind();
    const ports: DeckLifecyclePorts = {
      deckEl,
      activeDeck: () => activeDeckRef.current,
      deckTrack: (deck) => deckTrackRef.current[deck],
      clearDeckTrack: (deck) => {
        deckTrackRef.current[deck] = null;
      },
      sources: () => deckSources(),
      transitions: () => transitions(),
      bufferCarrying: (deck) => bufferDecks().carrying(deck),
      blendActive,
      crossfadeSeconds: () => effectiveCrossfadeSeconds(),
      wantPlay: () => wantPlayRef.current,
      report,
      advance,
      // A dead source EXITS a loop too: an automatic
      // replay of the same dead audio would hammer it forever.
      advanceOffFailure: () => {
        applyLoopEvent({ type: 'exit' });
        const failed = activeTrack();
        if (failed) deadSourcesRef.current.set(failed.queueItemId, sourceKeyOf(failed));
        const target = explicitNextTarget(isDeadSource);
        if (target) {
          playIndexOrWait(target.idx, 'record', target.wrapped ?? false);
          return;
        }
        // No Track with live audio is left: wait parked on the Track after the
        // one that just failed. The poll's resume path retries the parked Track
        // once per poll, so the retry moves along the Queue and playback returns
        // once ANY Track's audio does, not only the last one to fail.
        const failedIdx = failed
          ? queueRef.current.findIndex((t) => t.queueItemId === failed.queueItemId)
          : -1;
        waitAt(
          failedIdx >= 0 ? (failedIdx + 1) % queueRef.current.length : queueRef.current.length,
        );
      },
      resumePlay: (deck, el, track) => playAndConfirm(deck, el, track, false),
      unloadDeck,
      // A committed final upgrades armed Loop Track mode to its seamless pin.
      onSourceCommitted: (deck) => {
        if (deck !== activeDeckRef.current) return;
        const sourcePatch = committedSourcePatch(deck);
        patch(sourcePatch);
        const track = deckTrackRef.current[deck];
        if (
          playbackTraversalRef.current.mode === 'loop-track' &&
          sourcePatch.sourceKind !== 'final'
        ) {
          applyLoopEvent({ type: 'exit' });
          return;
        }
        armLoopTrackPin(deck, track);
      },
    };
    // The buffer transport's natural-end callback routes through these same
    // ports (one `ended` semantics for both transports).
    lifecyclePortsRef.current = ports;
    // A muted mount (pending handoff host) must be silent BEFORE its first
    // load; the engine re-applies the level when the graph attaches.
    applyOutputVolume();
    const unbind = bindDeckLifecycle({ a, b }, ports);
    return () => {
      unbind();
      lifecyclePortsRef.current = null;
      transitions().cancel();
      releaseAudioResources();
    };
  }, [
    advance,
    applyOutputVolume,
    armLoopTrackPin,
    blendActive,
    bufferDecks,
    committedSourcePatch,
    deckEl,
    deckSources,
    explicitNextTarget,
    isDeadSource,
    patch,
    activeTrack,
    applyLoopEvent,
    effectiveCrossfadeSeconds,
    playAndConfirm,
    playIndexOrWait,
    report,
    transitions,
    unloadDeck,
    waitAt,
  ]);

  // The debug chip's tier readout: mirror the tier of every
  // COMMITTED blend edge — the same telemetry the acceptance measurement
  // reads — into render state. Failed attempts stay out: their track arrives
  // later by a sequential hard cut, which is not an edge (and hard cuts clear
  // the readout in `cutOverTo`).
  useEffect(() => {
    const onEdge = (event: Event) => {
      const detail = (event as CustomEvent<BlendEdgeEventDetail>).detail;
      if (detail.committed) patch({ activeEdgeTier: detail.tier });
    };
    window.addEventListener('liedmotif:blend-edge', onEdge);
    return () => window.removeEventListener('liedmotif:blend-edge', onEdge);
  }, [patch]);

  // Apply the ordered Track projection from either Playback source. Session
  // snapshots additionally carry Queue/generation state; Playlist snapshots
  // remain transport-only.
  const isLocallyRemoved = useCallback(
    (queueItemId: string) => locallyRemovedRef.current.has(queueItemId),
    [],
  );
  const applyQueueSnapshot = useCallback(
    (snapshot: PlaybackSourceSnapshot) => {
      const sessionSnapshot = snapshot.kind === 'session' ? snapshot : null;
      let queueTracks = snapshot.tracks;
      const pinnedTrack =
        loopPinned() || sectionLoopRegion() ? deckTrackRef.current[activeDeckRef.current] : null;
      // A Queue item may remain authoritative while temporarily dropping out of
      // the playable projection (for example while its source availability is
      // being refreshed). Repeat-one pins the already-audible Track, so retain
      // that known-good projection until the raw Queue item actually vanishes.
      if (
        pinnedTrack &&
        snapshot.queueItemIds.has(pinnedTrack.queueItemId) &&
        !queueTracks.some((track) => track.queueItemId === pinnedTrack.queueItemId)
      ) {
        queueTracks = [...queueTracks];
        queueTracks.splice(Math.min(idxRef.current, queueTracks.length), 0, pinnedTrack);
      }
      queueRef.current = queueTracks;
      playbackTraversalRef.current.sync(queueTracks, activeTrack()?.queueItemId ?? null);

      // Repeat-one invalidations: a Change Vibe (moved
      // style revision), a stopped session, or a pinned item that vanished
      // from the projection all clear the pin and release its hold. A Section
      // loop ends on the same news.
      if (sessionSnapshot) {
        const { styleRevision, sessionStatus, queueItemIds } = sessionSnapshot;
        const known = styleRevisionRef.current;
        styleRevisionRef.current = styleRevision;
        const loopSnapshot = {
          revisionMoved: known != null && styleRevision !== known,
          sessionStatus,
          queueItemIds,
        };
        onLoopQueueSnapshot(loopSnapshot);
        onSectionLoopQueueSnapshot(loopSnapshot);
      }

      // Refresh the fields of the tracks the decks are HOLDING in place (same
      // object identity — play-settle guards compare by reference): a final
      // that landed mid-play updates `assets` for the next load boundary, and
      // Save state stays honest.
      for (const deck of ['a', 'b'] as const) {
        const held = deckTrackRef.current[deck];
        if (!held) continue;
        const fresh = queueTracks.find((t) => t.queueItemId === held.queueItemId);
        if (fresh) Object.assign(held, fresh);
      }

      // The Session Cover may change mid-session (the async generated cover
      // landing): refresh lock-screen artwork in place for the audible track.
      if (sessionSnapshot && sessionCoverRef.current !== sessionSnapshot.coverImageId) {
        sessionCoverRef.current = sessionSnapshot.coverImageId;
        const audible = deckTrackRef.current[activeDeckRef.current];
        if (audible) setMediaMetadata(audible);
      }

      // Resume restores the stored queue POSITION, not just the style: on the first
      // non-empty queue load, start at the server's current item. Applied once
      // so subsequent polls don't reset a session that is already playing.
      if (!startIndexAppliedRef.current && queueTracks.length > 0) {
        idxRef.current = resolveInitialPlaylistIndex(queueTracks, {
          currentQueueItemId: snapshot.currentQueueItemId,
          currentTrackId: snapshot.currentTrackId,
        });
        startIndexAppliedRef.current = true;
      } else {
        // Each poll replaces the projection, and removals (e.g. dislike) shift
        // later indices left — re-anchor the navigation cursor onto the track the
        // active deck is actually carrying so advance/resume continue from the
        // audible track (actions target the deck track directly via activeTrack).
        idxRef.current = reanchorPlaylistIndex(
          queueTracks,
          deckTrackRef.current[activeDeckRef.current]?.queueItemId ?? null,
          idxRef.current,
        );
      }

      // Queue replacement invalidates an in-flight preparation whose track is
      // no longer the transition target (the driver re-checks by queue item),
      // and trims the decode cache to current + next.
      transitions().syncTarget(resolveNextTarget());
      bufferDecks().retainOnly([
        deckTrackRef.current[activeDeckRef.current]?.trackId,
        resolveNextTarget()?.track.trackId,
      ]);

      // Both preparing states recover here: the first startable track flips
      // `loading` AND `waiting` to `ready`. A cursor parked on audio that
      // failed is not startable: the resume path's retry below runs under the
      // honest `waiting`.
      const cursorTrack = queueRef.current[idxRef.current];
      const nextStatus = snapshotPlayerStatus(
        statusRef.current,
        cursorTrack != null && !isDeadSource(cursorTrack),
      );
      statusRef.current = nextStatus;
      // Session signals stay at their initial values under a Playlist source —
      // the Session shell they drive is not rendered for one.
      const sessionSignals: Partial<PlaybackControllerState> = sessionSnapshot
        ? {
            generatedDurationSeconds: sessionSnapshot.generatedDurationSeconds,
            unknownDurationTrackCount: sessionSnapshot.unknownDurationTrackCount,
            generationStatus: sessionSnapshot.generationStatus,
            generationStatusScope: sessionSnapshot.generationStatusScope,
            statusMessageSafe: sessionSnapshot.statusMessageSafe,
            sessionStatus: sessionSnapshot.sessionStatus,
            sessionCoverImageId: sessionSnapshot.coverImageId,
            queueItems: sessionSnapshot.items,
            generatingTracksAhead: sessionSnapshot.generatingTracksAhead,
            generatingNewVibeTracksAhead: sessionSnapshot.generatingNewVibeTracksAhead,
            pendingGeneration: sessionSnapshot.pendingGeneration,
            styleRevision: sessionSnapshot.styleRevision,
            vibe: sessionSnapshot.vibe,
            switchPending: sessionSnapshot.switchPending,
          }
        : {};
      // Most polls confirm what the player already shows; keep the previous
      // state object then, so the context value stays referentially stable and
      // nothing re-renders (the app shell subscribes on every route).
      // The star and Add-to-Playlist state read the held track the toggles
      // read too, so a retention change made elsewhere can never invert a tap.
      const audible = deckTrackRef.current[activeDeckRef.current];
      const queuePatch: Partial<PlaybackControllerState> = {
        queueLength: queueTracks.length,
        earlierTracks: sessionSnapshot?.earlierTracks ?? 0,
        playableQueueItemIds: queueTracks.map((track) => track.queueItemId),
        status: nextStatus,
        ...(audible
          ? {
              currentFavorited: audible.favoritedAt != null,
              currentInCuratedPlaylist: audible.inCuratedPlaylist,
            }
          : {}),
        ...sessionSignals,
      };
      setState((s) => (patchLeavesStateUnchanged(s, queuePatch) ? s : { ...s, ...queuePatch }));

      if (sessionSnapshot) {
        // Switch-now cutover: advance into the first new-vibe track NOW,
        // mid-track, with skip mechanics minus feedback.
        const cutoverIdx = resolveVibeCutoverOnEdge({
          wasSwitchPending: switchPendingRef.current,
          switchPending: sessionSnapshot.switchPending,
          tracks: queueTracks,
          sessionStyleRevision: sessionSnapshot.styleRevision,
          // A paused deck is not audible: the cutover must never start audio
          // the listener paused (resume plays on and the advance walks past
          // the set-aside slots).
          active: wantPlayRef.current ? deckTrackRef.current[activeDeckRef.current] : null,
        });
        switchPendingRef.current = sessionSnapshot.switchPending;
        if (cutoverIdx != null) {
          applyLoopEvent({ type: 'exit' });
          playIndexOrWait(cutoverIdx);
          return;
        }
      }

      // The user wants to play but no deck carries a track (play pressed before the
      // first track arrived, or the queue played out): start the track at the cursor
      // as soon as it exists. A hard cut on the active deck — never `advance`, which
      // would skip past the cursor's (possibly first, paid) track.
      if (
        wantPlayRef.current &&
        !deckTrackRef.current[activeDeckRef.current] &&
        queueRef.current[idxRef.current]
      ) {
        playOnDeck(activeDeckRef.current, idxRef.current);
      }
    },
    [
      bufferDecks,
      activeTrack,
      applyLoopEvent,
      isDeadSource,
      loopPinned,
      onLoopQueueSnapshot,
      onSectionLoopQueueSnapshot,
      playIndexOrWait,
      playOnDeck,
      resolveNextTarget,
      setMediaMetadata,
      transitions,
    ],
  );
  // Ref-backed so cadence probes never restart the polling effect.
  const getIsPlaying = useCallback(() => statusRef.current === 'playing', []);
  const refreshQueue = usePlaybackSourceQueue(
    source,
    isLocallyRemoved,
    applyQueueSnapshot,
    getIsPlaying,
  );
  pollQueueNowRef.current = refreshQueue;

  /** Buffer-mode carrier watchdog: a rejected `play()` or background error
   * parks the muted carrier element, which would silently drop Android focus
   * AND the timeupdate stream the next transition rides on. Revive it
   * best-effort (re-synced to the buffer clock) and drive the preparation
   * trigger meanwhile — the audible buffer never depended on the carrier. */
  const reviveDeadCarrier = useCallback(() => {
    const deck = activeDeckRef.current;
    const el = deckEl(deck);
    if (!el || !el.paused || !wantPlayRef.current || bufferDecks().state(deck) !== 'playing') {
      return;
    }
    syncCarrierToBuffer(deck);
    void el.play().catch(() => undefined);
    if (blendActive() && Number.isFinite(el.duration) && el.duration > 0) {
      transitions().onTimeUpdate(
        el,
        crossfadeStartSeconds(el.duration, effectiveCrossfadeSeconds()),
      );
    }
  }, [
    blendActive,
    bufferDecks,
    deckEl,
    effectiveCrossfadeSeconds,
    syncCarrierToBuffer,
    transitions,
  ]);

  // Periodic position pings (live-only; never persisted) while playing —
  // positions come from the truthful clock (buffer transport during buffer
  // playback), the lock-screen position refreshes on the same cadence, the
  // cadence doubles as the buffer-mode carrier watchdog, and the loop lease
  // renews here too (~5 s — ample margin below the 60 s TTL; while paused the
  // renewals stop and the hold lapses by expiry, exactly as documented).
  useEffect(() => {
    if (state.status !== 'playing') return;
    // A pause can outlast the lease: win the hold back before a sweep buys.
    renewLoopLease();
    const id = setInterval(() => {
      report('position', activeTrack(), positionOf(activeDeckRef.current) ?? 0);
      publishPositionState();
      reviveDeadCarrier();
      renewLoopLease();
    }, POSITION_REPORT_MS);
    return () => clearInterval(id);
  }, [
    state.status,
    activeTrack,
    positionOf,
    publishPositionState,
    renewLoopLease,
    report,
    reviveDeadCarrier,
  ]);

  // Explicit lock-screen playback state: during
  // buffer playback the UA cannot infer it from the muted carrier element.
  useEffect(() => {
    if (!mediaSessionEnabled) return;
    setMediaSessionPlaybackState(
      state.status === 'playing' ? 'playing' : state.status === 'paused' ? 'paused' : 'none',
    );
  }, [state.status, mediaSessionEnabled]);

  // Media Session lock-screen controls. `seekto` (the OS scrubber) drives the
  // same controller seek funnel the progress slider commits into. Only the
  // owning host binds — a muted pending host must never capture the lock
  // screen away from the audible session.
  useEffect(() => {
    if (!mediaSessionEnabled) return;
    return bindMediaSessionActions({
      play: () => play(),
      pause: () => pause(),
      nexttrack: () => skip(),
      previoustrack: () => back(),
      seekto: (seconds) => seekTo(seconds),
    });
  }, [play, pause, skip, back, seekTo, mediaSessionEnabled]);

  // Media Session ownership can arrive mid-play (a pending host promoted by
  // the handoff): republish the audible track's metadata and position then.
  useEffect(() => {
    if (!mediaSessionEnabled) return;
    const track = deckTrackRef.current[activeDeckRef.current];
    if (track) {
      setMediaMetadata(track);
      publishPositionState();
    }
  }, [mediaSessionEnabled, publishPositionState, setMediaMetadata]);

  // The ONE titles-changed republish path: a Rename — of the
  // source (refreshed summary → new `sourceTitle` option) or of the audible
  // Track (local apply, or server truth landing via a poll's held-track
  // refresh) — must reach the lock screen, whose metadata carries both names.
  const sourceTitle = initial?.sourceTitle ?? null;
  const audibleTitle = state.currentTrack?.title ?? null;
  useEffect(() => {
    if (!mediaSessionEnabledRef.current) return;
    const track = deckTrackRef.current[activeDeckRef.current];
    if (track) setMediaMetadata(track);
  }, [audibleTitle, sourceTitle, setMediaMetadata]);

  // A committed Rename reflects immediately: the projection, the
  // held deck tracks, and the queue-sheet state, all without waiting for the
  // next poll (which would confirm the same server truth anyway). The
  // lock-screen republish rides the shared titles-changed effect below.
  const applyTrackTitle = useCallback((trackId: string, title: string) => {
    for (const track of queueRef.current) {
      if (track.trackId === trackId) track.title = title;
    }
    for (const deck of ['a', 'b'] as const) {
      const held = deckTrackRef.current[deck];
      if (held?.trackId === trackId) held.title = title;
    }
    setState((current) => ({
      ...current,
      queueItems: current.queueItems.map((item) =>
        item.trackId === trackId && item.track
          ? { ...item, track: { ...item.track, title } }
          : item,
      ),
    }));
  }, []);

  const playQueueItem = useCallback(
    (queueItemId: string) => {
      const idx = queueRef.current.findIndex((track) => track.queueItemId === queueItemId);
      if (idx < 0) return;
      userStartRef.current = true;
      queueTapStartRef.current = true;
      wantPlayRef.current = true;
      patch({ playIntentPending: true });
      void ensureEngine()?.resume();
      if (playbackTraversalRef.current.mode === 'loop-track') {
        applyLoopEvent({ type: 'exit' });
      }
      playOnDeck(activeDeckRef.current, idx);
    },
    [applyLoopEvent, ensureEngine, patch, playOnDeck],
  );

  // The repeat-one surface: assigned EVERY render, after everything it reads
  // exists; the coordinator reads it only at event time (never during render).
  repeatOneDepsRef.current = {
    queue: () => queueRef.current,
    activeDurationSeconds: () => playbackSampleOf(activeDeckRef.current).durationSeconds,
    crossfadeSetting: () => settingsRef.current.crossfadeSeconds,
    syncPreparedTarget: () => transitions().syncTarget(resolveNextTarget()),
    patch,
    // Offline a Section loop still runs, and nothing can buy while it does.
    onHoldFailed: () => {
      if (isOnline()) {
        flashActionError('Loop is on, but the generation hold failed — retrying shortly.');
      }
    },
  };

  sectionLoopDepsRef.current = {
    activeDeck: () => activeDeckRef.current,
    activeTrack,
    deckEl,
    buffers: bufferDecks,
    deviceAllows: deviceAllowsSectionLoop,
    muteElement: (deck) => engineRef.current?.setDeckMediaAudible(deck, false),
    abandonEdge,
    carryOnOnElement: (deck, seconds) => {
      const el = deckEl(deck);
      const track = activeTrack();
      enterElementMode(deck);
      if (!el || !track) return;
      el.currentTime = seconds;
      // A carrier can die under a playing buffer, so its pause says nothing here.
      if (wantPlayRef.current) playAndConfirm(deck, el, track, false);
    },
    syncCarrier: syncCarrierToBuffer,
    syncPreparedTarget: () => transitions().syncTarget(resolveNextTarget()),
    holdGeneration: (held) => holdLease('section-loop', held),
    positionMoved: (track, seconds) => {
      report('position', track, seconds);
      publishPositionState();
    },
    patch,
    notice: flashActionError,
  };

  // An open tool follows the audible Track, and picks up a final that lands.
  const currentQueueItemId = state.currentTrack?.queueItemId ?? null;
  const currentFinalPath = state.currentTrack?.assets.final ?? null;
  useEffect(() => {
    onSectionLoopTrackChanged(currentQueueItemId, currentFinalPath);
  }, [currentQueueItemId, currentFinalPath, onSectionLoopTrackChanged]);

  const canSectionLoop = state.currentTrack != null && deviceAllowsSectionLoop();

  return useMemo<PlaybackControllerApi>(() => {
    // The projection and `state` refresh together (every queue poll writes
    // state), so this index is never staler than the rendered queue length.
    const currentIndex = queueRef.current.findIndex(
      (t) => t.queueItemId === state.currentTrack?.queueItemId,
    );
    return {
      ...state,
      currentTrackNumber: currentIndex >= 0 ? state.earlierTracks + currentIndex + 1 : null,
      trackCount: state.earlierTracks + state.queueLength,
      deckARef,
      deckBRef,
      play,
      pause,
      skip,
      back,
      previous,
      restart,
      peekNeighbors,
      toggle,
      dislike,
      deleteTrack,
      advancePastDeletedTrack,
      applyRetentionFlags,
      toggleFavorite,
      cyclePlaybackMode,
      setPlaybackMode,
      playQueueItem,
      applyTrackTitle,
      loopHeld,
      blendEnabled,
      blendSettled,
      toggleBlend,
      getPlaybackSample,
      seekTo,
      sectionLoopAvailable: canSectionLoop,
      toggleSectionLoopTool,
      setSectionLoop,
      clearSectionLoop,
      setOutputVolume,
      refreshQueue,
    };
  }, [
    state,
    play,
    pause,
    skip,
    back,
    previous,
    restart,
    peekNeighbors,
    toggle,
    dislike,
    deleteTrack,
    advancePastDeletedTrack,
    applyRetentionFlags,
    toggleFavorite,
    cyclePlaybackMode,
    setPlaybackMode,
    playQueueItem,
    applyTrackTitle,
    loopHeld,
    blendEnabled,
    blendSettled,
    toggleBlend,
    getPlaybackSample,
    seekTo,
    canSectionLoop,
    toggleSectionLoopTool,
    setSectionLoop,
    clearSectionLoop,
    setOutputVolume,
    refreshQueue,
  ]);
}
