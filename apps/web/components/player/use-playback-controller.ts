'use client';

// The now-playing controller.
//
// Drives the `DeckRig` (two <audio> decks + the Web Audio PlayerEngine),
// derives the playable projection of the server-authoritative Session Queue
// (membership + normal Session order), and delegates blend transitions to the
// `EdgeTransitions` driver — which resolves every edge at the tier the edge policy decides:
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
  crossfadeStartSeconds,
  mediaSessionPositionState,
  type PlaybackReportType,
  type PlaybackMode,
  resolveSeekTarget,
  soloLoudnessGainDb,
} from '@liedmotif/shared';
import { reportPlayback } from '@/lib/api-client';
import { isOnline } from '@/lib/online-state';
import { useClientId } from '@/lib/use-client-id';
import { makeUuid } from '@/lib/uuid';
import { useListeningMeter } from './use-listening-meter';
import type { DeckId } from './audio-engine';
import { resolveVibeCutoverOnEdge } from './vibe-switch-view';
import { bindDeckLifecycle, type DeckLifecyclePorts } from './deck-lifecycle';
import { DeckRig } from './deck-rig';
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
import { rejectedPlayFallbackStatus, snapshotPlayerStatus, toggleIntent } from './player-status';
import type { ShuffleTransition } from './playback-traversal';
import { QueueCursor } from './queue-cursor';
import { sessionTrackNumbering } from './session-loop-head';
import {
  initialPlaybackControllerState,
  type PlaybackSample,
  type PlayerControllerSource,
  type PlayerStatus,
  type PlaybackControllerApi,
  type PlaybackControllerInit,
  type PlaybackControllerState,
} from './playback-controller-api';
import { patchLeavesStateUnchanged } from './state-patch';
import { clearPlayerError, showPlayerError } from './player-error-toast';
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
// Back past this position restarts the current track instead of stepping to the
// previous one (the universal player idiom — double-tap to actually go back).
const BACK_RESTART_SECONDS = 3;

const NEVER_EXPIRES = (): boolean => false;

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
  // The engaged source's id (`engagedSourceId`), which keys its failure toasts.
  const sourceId = source.kind === 'session' ? source.sessionId : source.playlistId;
  const sourceKind = source.kind;
  const offline = source.kind === 'playlist' && source.offline === true;
  // Read at every start, never captured: an offline copy can expire while
  // the Playlist plays.
  const expiredRef = useRef<(trackId: string) => boolean>(NEVER_EXPIRES);
  expiredRef.current = (source.kind === 'playlist' && source.expired) || NEVER_EXPIRES;
  const expired = useCallback((track: PlayableTrack) => expiredRef.current(track.trackId), []);
  const deckARef = useRef<HTMLAudioElement | null>(null);
  const deckBRef = useRef<HTMLAudioElement | null>(null);
  const clientId = useClientId();

  // Playback bookkeeping in refs (handlers/intervals must not read stale React state).
  // The queue cursor (queue-cursor.ts), built once: the playable projection of
  // the Session Queue, its cursor index, the loop head and the traversal.
  const cursorRef = useRef<QueueCursor | null>(null);
  const cursor = (cursorRef.current ??= new QueueCursor(expired));
  // The deck lifecycle's ports while bound; the buffer transport's natural
  // end reaches the lifecycle semantics through this ref.
  const lifecyclePortsRef = useRef<DeckLifecyclePorts | null>(null);
  // Owner playback settings (defaults until the fetch SETTLES — see the hook).
  const {
    settingsRef,
    settledRef: settingsSettledRef,
    blendEnabled,
    blendSettled,
    setBlendEnabled,
    adoptStoredSettings,
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
  // Armed at mount for a session the user just started: the
  // start-session click is the play intent, so the first playable track
  // auto-starts from the queue poll. Pause disarms; a rejected play falls
  // back through `rejectedPlayFallbackStatus`.
  const wantPlayRef = useRef<boolean>(initial?.autoplay ?? false);
  // The audio rig (deck-rig.ts), built once; its host getters are read at
  // call time. `deckARef` / `deckBRef` stay here for the JSX `ref`.
  const rigRef = useRef<DeckRig | null>(null);
  const rig = (rigRef.current ??= new DeckRig(
    {
      deckEl: (deck) => (deck === 'a' ? deckARef.current : deckBRef.current),
      wantPlay: () => wantPlayRef.current,
      blendSetting: () => settingsSettledRef.current && settingsRef.current.blendEnabled,
      onDeckEnteredElement: (deck) => onSectionLoopDeckEnteredElement(deck),
      lifecyclePorts: () => lifecyclePortsRef.current,
    },
    initial?.initialOutputVolume ?? 1,
  ));
  const statusRef = useRef<PlayerStatus>('loading');
  const playIntentPendingRef = useRef<boolean>(initial?.autoplay ?? false);
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
    if (next.playIntentPending !== undefined) playIntentPendingRef.current = next.playIntentPending;
    setState((s) => ({ ...s, ...next }));
  }, []);

  // Whether this controller owns the global Media Session — exactly one of
  // the provider's hosts (the visible entry) may. Re-read live every render.
  const mediaSessionEnabled = initial?.mediaSessionEnabled ?? true;
  const mediaSessionEnabledRef = useRef(mediaSessionEnabled);
  mediaSessionEnabledRef.current = mediaSessionEnabled;

  // Personal-analytics metering rides beside the playback reports
  // and shares nothing with them: no Session field, Buffer gate, or transport
  // decision reads it. Zero output volume is the app's own silence (a pending
  // host, the far end of a cross-Session fade); the device's volume is not ours
  // to know.
  // A Section loop can land its wrapped position on the same value at two
  // observations, so advancing is read off the context clock while one runs.
  const listeningMeter = useListeningMeter(state.status === 'playing', () => ({
    position: sectionLoopRegion() ? (rig.engine()?.now() ?? null) : rig.position(rig.activeDeck),
    audible: rig.outputLevel() > 0,
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
  // A fresh start the browser blocked still owes its `started`: the deck keeps
  // the Track, so the Play that follows is a resume in shape but the first
  // audible start of that load.
  const owedStartRef = useRef<{
    deck: DeckId;
    track: PlayableTrack;
    queueWrapped: boolean;
  } | null>(null);

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
        type === 'started' && cursor.traversal.mode === 'shuffle' && !queueTapStartRef.current;
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

  const setOutputVolume = useCallback((volume: number) => rig.setOutputVolume(volume), []);

  /** The UI-facing sample of the ACTIVE deck — the progress slider's polling
   * read (position stays out of render state by design). */
  const getPlaybackSample = useCallback((): PlaybackSample => rig.sample(rig.activeDeck), []);

  /** Publish the lock-screen position from the truthful clock (the context
   * clock during buffer playback — never the muted carrier element). A
   * caller holding a BETTER sample than a live read would produce passes it
   * explicitly — the seek funnel during the pre-metadata window: the element
   * cannot answer yet, but the queue metadata resolved the clamp, and the OS
   * slider must land at the target instead of clearing. */
  const publishPositionState = useCallback((sample?: PlaybackSample) => {
    if (!mediaSessionEnabledRef.current) return;
    publishMediaSessionPosition(mediaSessionPositionState(sample ?? rig.sample(rig.activeDeck)));
  }, []);

  /** The render-state source kind committed by a deck's pinned URL ladder. */
  const committedSourcePatch = useCallback(
    (deck: DeckId): Pick<PlaybackControllerState, 'sourceKind'> => ({
      sourceKind: rig.sources().committedKind(deck),
    }),
    [],
  );

  /** The next Track after the audible one that may start, passing over expired
   * ones and any `skip` rejects. */
  const explicitNextTarget = useCallback(
    (skip?: (track: PlayableTrack) => boolean): QueueTarget | null =>
      cursor.nextTarget(rig.activeTrack()?.queueItemId ?? null, skip),
    [],
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
    if (loopPinned()) {
      // An expired pinned Track gets no further pass: it runs out, and its
      // natural end moves on.
      const seam = loopSeamTarget();
      return seam && !expired(seam.track) ? seam : null;
    }
    if (cursor.traversal.mode === 'loop-track') {
      return null;
    }
    return explicitNextTarget();
  }, [expired, explicitNextTarget, loopPinned, loopSeamTarget, sectionLoopRegion]);

  /** Arm Loop Track's seamless pin once `deck` commits a downloaded final (the
   * pin is restricted to finals). Before that the mode still holds generation:
   * new generation waits while Loop Track is on, whatever the Track's source.
   * A no-op outside Loop Track, with no Track, or while a pin is already live. */
  const armLoopTrackPin = useCallback(
    (deck: DeckId, track: PlayableTrack | null) => {
      if (cursor.traversal.mode !== 'loop-track' || !track || loopPinned()) return;
      if (rig.sources().committedKind(deck) !== 'final') {
        holdLease('loop-track', true);
        return;
      }
      applyLoopEvent({
        type: 'toggle-on',
        track: { queueItemId: track.queueItemId, trackId: track.trackId },
      });
    },
    [applyLoopEvent, holdLease, loopPinned],
  );

  /** The logical handoff of a blend transition (the driver calls this at the
   * fade boundary): the incoming deck becomes the audible current track and the
   * `started` report + cursor + metadata land now. */
  const commitHandoff = useCallback(
    (deck: DeckId, track: PlayableTrack, idx: number, queueWrapped = false) => {
      const outgoing = rig.activeTrack();
      cursor.traversal.commit(outgoing?.queueItemId ?? null, track.queueItemId);
      rig.carry(deck, track);
      rig.activeDeck = deck;
      cursor.idx = idx;
      // The loop pin reacts to what became current BEFORE the next-target
      // reads below: a seam replay keeps the pin and a different track ends it,
      // so `retainOnly` sees the post-pin truth.
      applyLoopEvent({ type: 'committed', queueItemId: track.queueItemId });
      armLoopTrackPin(deck, track);
      owedStartRef.current = null;
      // The REAL playback position (buffer clock or element): an aligned
      // pre-roll has already advanced past zero — a Stop right after the
      // handoff must resume there, not replay it.
      overlapStartMsRef.current = outgoing ? effectiveCrossfadeSeconds() * 1000 : 0;
      report('started', track, rig.position(deck) ?? 0, queueWrapped);
      overlapStartMsRef.current = 0;
      setMediaMetadata(track);
      publishPositionState();
      // Hold at most current + next decoded finals; release on advance.
      rig.buffers().retainOnly([track.trackId, resolveNextTarget()?.track.trackId]);
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
      armLoopTrackPin,
      committedSourcePatch,
      patch,
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
      deckEl: (deck) => rig.el(deck),
      engine: () => rig.engine(),
      // The loop seam shortens the effective crossfade to its overlap; every
      // other edge sees the owner setting unchanged.
      settings: () => ({
        ...settingsRef.current,
        crossfadeSeconds: effectiveCrossfadeSeconds(),
      }),
      activeDeck: () => rig.activeDeck,
      deckTrack: (deck) => rig.deckTrack(deck),
      committedKind: (deck) => rig.sources().committedKind(deck),
      // Every element (re)load leaves buffer mode first: the ladder walk must
      // be audible unless a buffer edge explicitly gates it again.
      loadDeck: (deck, track) => {
        rig.enterElementMode(deck);
        return rig.sources().begin(deck, track);
      },
      unloadDeck: (deck) => rig.unload(deck),
      nextTarget: () => resolveNextTarget(),
      startable: (track) => !expired(track),
      commit: (deck, track, idx, queueWrapped) => commitHandoff(deck, track, idx, queueWrapped),
      buffers: () => rig.buffers(),
      bufferEligible: () => rig.bufferEligible(),
    });
    return transitionsRef.current;
  }, [commitHandoff, effectiveCrossfadeSeconds, expired, resolveNextTarget]);

  /** The next target may have changed around the audible `currentTrackId`: an
   * in-flight preparation for another Track is dropped, and the decode cache is
   * trimmed to current + next. */
  const retargetNext = useCallback(
    (currentTrackId: string | undefined) => {
      transitions().syncTarget(resolveNextTarget());
      rig.buffers().retainOnly([currentTrackId, resolveNextTarget()?.track.trackId]);
    },
    [resolveNextTarget, transitions],
  );

  /** Only expired Tracks are left: playback ends, with nothing parked to
   * retry or loop. */
  const endPlayback = useCallback(() => {
    transitions().cancel();
    applyLoopEvent({ type: 'exit' });
    rig.unload('a');
    rig.unload('b');
    wantPlayRef.current = false;
    patch({
      status: 'ended',
      playIntentPending: false,
      currentTrack: null,
      currentFavorited: false,
      currentInCuratedPlaylist: false,
      sourceKind: null,
      activeEdgeTier: null,
    });
  }, [applyLoopEvent, patch, transitions]);

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
      const stillCurrent = () => rig.activeDeck === deck && rig.deckTrack(deck) === track;
      const owed = owedStartRef.current;
      const owesStart = !reportStart && owed?.deck === deck && owed.track === track;
      const freshStart = reportStart || owesStart;
      const wrapped = reportStart ? queueWrapped : owesStart && owed?.queueWrapped === true;
      const attempt = (src: string): Promise<void> =>
        el.play().then(
          () => {
            if (stillCurrent() && !el.paused) {
              // Every navigation that starts audio (Skip, Back, swipe, Reroll)
              // lands here, so the play intent follows what is audible.
              wantPlayRef.current = true;
              deadSourcesRef.current.clear();
              patch({ status: 'playing', playIntentPending: false });
              if (freshStart) {
                owedStartRef.current = null;
                report('started', track, el.currentTime, wrapped);
              }
            }
          },
          () => {
            if (!stillCurrent()) return;
            // A ladder step-down reloaded the element and re-played it, which
            // rejects this play(): the re-play owns the outcome, and a fresh
            // start still owes its `started` report once it is audible.
            if (el.src !== src) {
              if (freshStart && wantPlayRef.current) attempt(el.src);
              return;
            }
            // A blocked FRESH start (including the auto-start) lands in
            // `ready`: a live Play button, never a stuck
            // spinner or a phantom pause. A blocked resume keeps `paused`.
            wantPlayRef.current = false;
            if (freshStart) owedStartRef.current = { deck, track, queueWrapped: wrapped };
            patch({
              status: rejectedPlayFallbackStatus(freshStart),
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
      const el = rig.el(deck);
      const engine = rig.ensureEngine();
      if (!el) return false;
      // Explicit navigation is always an ELEMENT load boundary: a
      // buffer playing on this deck stops deliberately, the gate reopens, and
      // the pinned ladder re-runs. The buffer tier re-enters at the next
      // qualifying edge via the mixed bootstrap.
      rig.enterElementMode(deck);
      if (!rig.sources().begin(deck, track)) return false;
      owedStartRef.current = null;
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
    [committedSourcePatch, patch, playAndConfirm],
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
      let track = cursor.tracks[idx];
      if (!track) return;
      // Every hard-cut start passes here: an expired Track is passed over for
      // the next one that may still play.
      if (expired(track)) {
        const target = explicitNextTarget();
        if (!target) {
          endPlayback();
          return;
        }
        idx = target.idx;
        track = target.track;
        queueWrapped = target.wrapped ?? false;
      }

      transitions().cancel();
      const previousDeck = rig.activeDeck;
      if (!cutOverTo(deck, track, queueWrapped)) return;

      cursor.traversal.commit(
        rig.activeTrack()?.queueItemId ?? null,
        track.queueItemId,
        shuffleTransition,
      );

      // A hard cut abandons the deck we're leaving; stop it and forget its track
      // so its later `ended` can't report a spurious play.
      if (previousDeck !== deck) rig.unload(previousDeck);

      rig.carry(deck, track);
      rig.activeDeck = deck;
      cursor.idx = idx;
      // A cut-over to a DIFFERENT track ends a loop pin (Back to previous, the
      // failure path); replaying the pinned track (loop restart, Back-restart)
      // keeps it. The fresh load has no committed source yet — the toggle
      // re-enables when the pinned final commits (`onSourceCommitted`).
      applyLoopEvent({ type: 'committed', queueItemId: track.queueItemId });
      setMediaMetadata(track);
      // Hard-cut navigation advances the current track too: trim the decode
      // cache to current + next NOW, not at the next queue poll (Skip/Back/
      // sequential advance must never let three decoded finals accumulate).
      rig.buffers().retainOnly([track.trackId, resolveNextTarget()?.track.trackId]);
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
      cutOverTo,
      endPlayback,
      expired,
      explicitNextTarget,
      patch,
      resolveNextTarget,
      setMediaMetadata,
      transitions,
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
      rig.unload('a');
      rig.unload('b');
      cursor.idx = Math.min(idx, cursor.tracks.length);
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
    [patch, transitions],
  );

  /** Play `idx` on the other deck, or stop and wait when no playable target exists. */
  const playIndexOrWait = useCallback(
    (idx: number, shuffleTransition: ShuffleTransition = 'record', queueWrapped = false) => {
      const other: DeckId = rig.activeDeck === 'a' ? 'b' : 'a';
      if (cursor.tracks[idx]) {
        playOnDeck(other, idx, shuffleTransition, queueWrapped);
      } else if (cursor.tracks.some(expired)) {
        // Nothing arrives to replace an expired copy.
        endPlayback();
      } else {
        // Queue exhausted: park the cursor on the slot the next arriving track
        // fills, so resume starts there instead of replaying or skipping past it.
        waitAt(idx);
      }
    },
    [endPlayback, expired, playOnDeck, waitAt],
  );

  /** Natural advance to the next track (sequential hard cut), loop, or wait.
   * A live loop pin re-targets the pinned track itself: the seam normally
   * fires before the end, so reaching here IS the natural-end restart (the
   * too-short track, `blendEnabled: false`, or a failed seam preparation). */
  const advance = useCallback(() => {
    const loop = loopRestartTarget();
    if (loop || cursor.traversal.mode === 'loop-track') {
      const current = rig.activeTrack();
      const currentIdx = current
        ? cursor.tracks.findIndex((track) => track.queueItemId === current.queueItemId)
        : -1;
      playIndexOrWait(loop?.idx ?? (currentIdx >= 0 ? currentIdx : cursor.tracks.length));
      return;
    }
    const target = explicitNextTarget();
    playIndexOrWait(target?.idx ?? cursor.tracks.length, 'record', target?.wrapped ?? false);
  }, [explicitNextTarget, loopRestartTarget, playIndexOrWait]);

  const setPlaybackMode = useCallback(
    (next: PlaybackMode) => {
      const previous = cursor.traversal.mode;
      if (next === previous) return;

      if (previous === 'loop-track') applyLoopEvent({ type: 'exit' });
      cursor.traversal.select(next, cursor.tracks, rig.activeTrack()?.queueItemId ?? null);

      const current = rig.activeTrack();
      armLoopTrackPin(rig.activeDeck, current);

      retargetNext(current?.trackId);
      patch({ playbackMode: next });
    },
    [applyLoopEvent, armLoopTrackPin, patch, retargetNext],
  );

  const cyclePlaybackMode = useCallback(() => {
    setPlaybackMode(cursor.traversal.nextMode());
  }, [setPlaybackMode]);

  const play = useCallback(() => {
    wantPlayRef.current = true;
    patch({ playIntentPending: true });
    void rig.ensureEngine()?.resume();
    const deck = rig.activeDeck;
    const el = rig.el(deck);
    const track = rig.deckTrack(deck);
    // Resume only while the active deck carries a live track; after the queue plays
    // out (or a dislike empties it) the deck is stopped and its leftover src must not
    // be resumable — start whatever the cursor points at instead.
    if (el && track) {
      const buffers = rig.buffers();
      if (buffers.state(deck) === 'paused') {
        // Buffer resume: recreate the source at the recorded offset, re-sync
        // the muted carrier, keep it rolling for focus (best-effort — the
        // audible audio is the buffer either way).
        const resumed = buffers.resume(deck);
        // Either way the element seeks to the recorded offset: the carrier
        // re-syncs on success, and the ELEMENT-PATH FALLBACK must resume at
        // the same position — never restart from the carrier's stale time
        // (a failed resume rolls back to `paused`, so the offset survives).
        rig.syncCarrier(deck);
        if (resumed) {
          void el.play().catch(() => undefined);
          publishPositionState();
          patch({ status: 'playing', playIntentPending: false });
          return;
        }
        // The context is gone: fall back to the element path truthfully.
        rig.enterElementMode(deck);
      }
      playAndConfirm(deck, el, track, false);
      return;
    }
    if (cursor.tracks[cursor.idx]) {
      playOnDeck(deck, cursor.idx);
      return;
    }
    // Nothing buffered to start. Playback reports are what mark the session as
    // "someone is listening" for the worker's playback-gated buffer controller —
    // a trackless position ping records the intent so the next sweep tops the
    // buffer up; the queue poll then auto-starts the first arriving track.
    report('position', null, null);
  }, [patch, playAndConfirm, playOnDeck, publishPositionState, report]);

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
      if (deck === rig.activeDeck) continue;
      const track = rig.deckTrack(deck);
      if (!track) continue;
      report('ended', track, rig.position(deck));
      rig.el(deck)?.pause();
      rig.buffers().stop(deck);
      rig.carry(deck, null);
      rig.sources().clear(deck);
      rig.engine()?.hardCut(rig.activeDeck, soloLoudnessGainDb(loudnessOf(rig.activeTrack())));
    }
  }, [report]);

  const pause = useCallback(() => {
    wantPlayRef.current = false;
    // A prepared/armed transition cannot survive a pause: its fade would run
    // against paused elements. Cancel it; resume re-prepares from timeupdate.
    // A live loop pin survives the pause; only its lease can lapse by TTL.
    transitions().cancel();
    applyLoopEvent({ type: 'seam-cancelled' });
    for (const deck of ['a', 'b'] as const) {
      rig.el(deck)?.pause();
    }
    // A buffer-carrying active deck records its exact offset (the source node
    // is one-shot: stop now, recreate at the offset on resume).
    rig.buffers().pause(rig.activeDeck);
    // A NON-active deck still fading out its tail is abandoned by a pause —
    // close it out truthfully and settle onto the active deck.
    settleToActiveDeck();
    patch({ status: 'paused', playIntentPending: false });
  }, [applyLoopEvent, patch, settleToActiveDeck, transitions]);

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
      const deck = rig.activeDeck;
      const track = rig.deckTrack(deck);
      const el = rig.el(deck);
      if (!track || !el) return;
      // Duration resolution: the live sample (buffer duration or finite
      // element duration) outranks the queue metadata; metadata covers the
      // pre-metadata element window. No trustworthy duration → seeking off.
      const sample = rig.sample(deck);
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

      const buffers = rig.buffers();
      if (buffers.carrying(deck)) {
        if (buffers.seekTo(deck, target)) {
          rig.syncCarrier(deck);
        } else {
          // A playing-path source recreation failed: the transport rolled
          // back to `paused` at the target. Fall back to the element path
          // truthfully — never an unmuted-but-silent carrier while the
          // status says `playing` (the same sequence `play()`'s
          // buffer-resume fallback performs).
          rig.enterElementMode(deck);
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
      clearSectionLoop,
      playAndConfirm,
      publishPositionState,
      report,
      sectionLoopRegion,
    ],
  );

  // The in-player blend toggle: the settings hook flips the live gate and
  // persists; a write that did not land is an error toast.
  // Turning blends OFF also strikes the edge already in flight — aligned
  // automation arms at readiness, well before the fade start, and would
  // otherwise still crossfade; the cancelled target advances on `ended`
  // instead (and re-prepares if the write fails and the setting reverts).
  const toggleBlend = useCallback(() => {
    const enabled = !settingsRef.current.blendEnabled;
    if (!enabled) transitions().cancel();
    clearPlayerError(sourceId, 'blend');
    void setBlendEnabled(enabled).then((error) => {
      if (error) showPlayerError(sourceId, 'blend', error);
    });
  }, [setBlendEnabled, settingsRef, sourceId, transitions]);

  // Settings saved past the player (by the Assistant or Settings → Playback):
  // played from the next transition, and blending turned off strikes the edge
  // in flight as the toggle does.
  const adoptStoredPlaybackSettings = useCallback(() => {
    const wasBlending = settingsRef.current.blendEnabled;
    void adoptStoredSettings().then(() => {
      if (wasBlending && !settingsRef.current.blendEnabled) transitions().cancel();
    });
  }, [adoptStoredSettings, settingsRef, transitions]);

  // The queue poll wake-up, assigned once `usePlaybackSourceQueue` runs below;
  // ref-held so earlier hooks (track actions) can close over it.
  const pollQueueNowRef = useRef<() => void>(() => {});

  const removeFromQueue = useCallback((queueItemId: string) => {
    cursor.remove(queueItemId);
    setState((current) => ({
      ...current,
      queueItems: current.queueItems.filter((item) => item.id !== queueItemId),
      queueLength: cursor.tracks.length,
      playableQueueItemIds: cursor.tracks.map((track) => track.queueItemId),
    }));
  }, []);

  // A removed track cannot remain pinned or in shuffle history. The mode
  // stays selected and applies to the replacement track.
  const advancePastCurrent = useCallback(() => {
    applyLoopEvent({ type: 'exit' });
    const target = explicitNextTarget();
    playIndexOrWait(target?.idx ?? cursor.tracks.length, 'discard', target?.wrapped ?? false);
  }, [applyLoopEvent, explicitNextTarget, playIndexOrWait]);

  // Feedback-loop actions — semantics in use-track-actions.
  const {
    dislike,
    deleteTrack,
    applyRetentionFlags,
    applyRetentionAdded,
    toggleFavorite,
    reportSkip,
  } = useTrackActions({
    sourceId,
    sessionId,
    activeTrack: () => rig.activeTrack(),
    patch,
    queueChanged: () => pollQueueNowRef.current(),
    markRemoved: (queueItemId) => locallyRemovedRef.current.add(queueItemId),
    unmarkRemoved: (queueItemId) => locallyRemovedRef.current.delete(queueItemId),
    removeFromQueue,
    advancePastCurrent,
  });

  /** Delete Track and a removal from the playing Playlist are not feedback:
   * unlike Skip, moving past the removed Track records neither a `skip` event
   * nor a `skipped` report. A Track that is no longer the audible one only
   * leaves the projection: the audible Track plays on where it is, and a deck
   * already prepared with the removed one is struck. */
  const advancePastDeletedTrack = useCallback(
    (trackId: string) => {
      const audible = rig.activeTrack();
      if (audible?.trackId === trackId) {
        locallyRemovedRef.current.add(audible.queueItemId);
        removeFromQueue(audible.queueItemId);
        advancePastCurrent();
        return;
      }
      const removedIdx = cursor.tracks.findIndex((queued) => queued.trackId === trackId);
      if (removedIdx === -1) return;
      const { queueItemId } = cursor.tracks[removedIdx]!;
      locallyRemovedRef.current.add(queueItemId);
      removeFromQueue(queueItemId);
      cursor.shiftForRemovalAt(removedIdx);
      retargetNext(audible?.trackId);
    },
    [advancePastCurrent, removeFromQueue, retargetNext],
  );

  const skip = useCallback(() => {
    const track = rig.activeTrack();
    if (!track) return;
    // The loop-track mode stays selected, but its pin follows the next track.
    applyLoopEvent({ type: 'exit' });
    report('skipped', track, rig.position(rig.activeDeck));
    reportSkip(track);
    const target = explicitNextTarget();
    playIndexOrWait(target?.idx ?? cursor.tracks.length, 'record', target?.wrapped ?? false);
  }, [explicitNextTarget, playIndexOrWait, applyLoopEvent, report, reportSkip]);

  /** Restart the current track. It RE-RUNS the pinned source ladder:
   * a final that landed while the stream was playing is
   * picked up here, making restart a real load boundary rather than a seek to
   * zero — even when the track already left the queue projection (the ladder
   * then optimistically includes the deterministic pinned-final path for the
   * track id; a pinned URL whose asset does not exist 404s and the ladder steps
   * down, so trying it is safe by construction). */
  const restart = useCallback(() => {
    const el = rig.el(rig.activeDeck);
    const track = rig.activeTrack();
    if (!el || !track) {
      userStartRef.current = false;
      return;
    }
    userStartRef.current = true;
    const idx = cursor.tracks.findIndex((t) => t.queueItemId === track.queueItemId);
    if (idx >= 0) {
      playOnDeck(rig.activeDeck, idx);
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
    if (!cutOverTo(rig.activeDeck, track)) {
      // A rewind starts no occurrence, so it must not lend its origin to the
      // blend handoff that follows.
      el.currentTime = 0;
      userStartRef.current = false;
    }
  }, [cutOverTo, playOnDeck, transitions]);

  /** Step to the previous Track even mid-track — the cover swipe, whose preview
   * shows that Track, so a restart would contradict it. Falls back to a restart
   * when none precedes the cursor — never to silence. */
  const previous = useCallback(() => {
    userStartRef.current = true;
    const traversal = cursor.traversal;
    const current = rig.activeTrack()?.queueItemId ?? null;
    if (traversal.mode === 'shuffle') {
      // Going back passes over expired offline copies in the same direction.
      const target = traversal.previous(cursor.tracks, current, expired);
      if (target) playOnDeck(rig.activeDeck, target.idx, 'preserve');
      else restart();
      return;
    }
    const target = cursor.previousStartableIndex();
    if (target == null) {
      restart();
      return;
    }
    if (traversal.mode === 'loop-track') applyLoopEvent({ type: 'exit' });
    playIndexOrWait(target);
  }, [applyLoopEvent, expired, playIndexOrWait, playOnDeck, restart]);

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
      cursor.traversal.mode !== 'shuffle' &&
      rig.activeTrack() !== null &&
      rig.el(rig.activeDeck) !== null &&
      (rig.position(rig.activeDeck) ?? 0) > BACK_RESTART_SECONDS;
    if (underway) restart();
    else previous();
  }, [previous, restart, sectionLoopRegion, seekTo]);

  /** The Tracks a cover swipe would land on: what Skip plays next and what
   * `previous` returns to. Read on demand — the shuffle peek syncs traversal. */
  const peekNeighbors = useCallback((): {
    next: PlayableTrack | null;
    previous: PlayableTrack | null;
  } => {
    const previousTrack = cursor.peekPrevious(rig.activeTrack()?.queueItemId ?? null);
    return { next: explicitNextTarget()?.track ?? null, previous: previousTrack };
  }, [explicitNextTarget]);

  const toggle = useCallback(() => {
    // Pause also DISARMS a pending auto-start (armed intent, nothing loaded
    // yet) and cancels a start whose play() has not settled, the two states
    // the button reads Pause in; otherwise, with a track loaded, it plays.
    const intent = toggleIntent(statusRef.current, wantPlayRef.current, rig.activeTrack() != null);
    if (intent === 'pause' || playIntentPendingRef.current) pause();
    else play();
  }, [pause, play]);

  // Deck DOM event lifecycle (deck-lifecycle.ts owns the semantics); the
  // engine — created lazily on a play gesture — is disposed here on unmount.
  useEffect(() => {
    const a = deckARef.current;
    const b = deckBRef.current;
    if (!a || !b) return;
    const releaseAudioResources = rig.lifetime.bind();
    const ports: DeckLifecyclePorts = {
      deckEl: (deck) => rig.el(deck),
      activeDeck: () => rig.activeDeck,
      deckTrack: (deck) => rig.deckTrack(deck),
      clearDeckTrack: (deck) => {
        rig.carry(deck, null);
      },
      sources: () => rig.sources(),
      transitions: () => transitions(),
      bufferCarrying: (deck) => rig.buffers().carrying(deck),
      blendActive: () => rig.blendActive(),
      crossfadeSeconds: () => effectiveCrossfadeSeconds(),
      wantPlay: () => wantPlayRef.current,
      report,
      advance,
      // A dead source EXITS a loop too: an automatic
      // replay of the same dead audio would hammer it forever.
      advanceOffFailure: () => {
        applyLoopEvent({ type: 'exit' });
        const failed = rig.activeTrack();
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
          ? cursor.tracks.findIndex((t) => t.queueItemId === failed.queueItemId)
          : -1;
        waitAt(failedIdx >= 0 ? (failedIdx + 1) % cursor.tracks.length : cursor.tracks.length);
      },
      resumePlay: (deck, el, track) => playAndConfirm(deck, el, track, false),
      unloadDeck: (deck) => rig.unload(deck),
      // A committed final upgrades armed Loop Track mode to its seamless pin;
      // any other source ends a pin (the seam needs the final) and keeps the hold.
      onSourceCommitted: (deck) => {
        if (deck !== rig.activeDeck) return;
        const sourcePatch = committedSourcePatch(deck);
        patch(sourcePatch);
        const track = rig.deckTrack(deck);
        if (
          cursor.traversal.mode === 'loop-track' &&
          sourcePatch.sourceKind !== 'final' &&
          loopPinned()
        ) {
          applyLoopEvent({ type: 'exit' });
        }
        armLoopTrackPin(deck, track);
      },
    };
    // The buffer transport's natural-end callback routes through these same
    // ports (one `ended` semantics for both transports).
    lifecyclePortsRef.current = ports;
    // A muted mount (pending handoff host) must be silent BEFORE its first
    // load, while no graph exists and the level rides element volume.
    rig.applyOutputVolume();
    const unbind = bindDeckLifecycle({ a, b }, ports);
    return () => {
      unbind();
      lifecyclePortsRef.current = null;
      transitions().cancel();
      releaseAudioResources();
    };
  }, [
    advance,
    armLoopTrackPin,
    committedSourcePatch,
    explicitNextTarget,
    isDeadSource,
    loopPinned,
    patch,
    applyLoopEvent,
    effectiveCrossfadeSeconds,
    playAndConfirm,
    playIndexOrWait,
    report,
    transitions,
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
      // A loop holds the audible Track in the projection while its Queue item remains.
      const pinnedTrack = loopPinned() || sectionLoopRegion() ? rig.activeTrack() : null;
      const queueTracks = cursor.applyProjection(
        {
          loopHead: sessionSnapshot?.loopHead ?? null,
          tracks: snapshot.tracks,
          queueItemIds: snapshot.queueItemIds,
        },
        pinnedTrack,
        rig.activeTrack()?.queueItemId ?? null,
      );

      // Repeat-one invalidations: a Change Vibe (moved
      // style revision), a stopped session, or a pinned item that vanished
      // from the projection all clear the pin and release its hold. A Change
      // Vibe also leaves Loop Track for the default mode, so the looped Track
      // plays out and the Queue moves on (ADR 0014). A Section loop ends on
      // the same news.
      if (sessionSnapshot) {
        const { styleRevision, sessionStatus, queueItemIds } = sessionSnapshot;
        const known = styleRevisionRef.current;
        styleRevisionRef.current = styleRevision;
        const loopSnapshot = {
          revisionMoved: known != null && styleRevision !== known,
          sessionStatus,
          queueItemIds,
        };
        if (loopSnapshot.revisionMoved && cursor.traversal.mode === 'loop-track') {
          setPlaybackMode('loop-session');
        }
        onLoopQueueSnapshot(loopSnapshot);
        onSectionLoopQueueSnapshot(loopSnapshot);
      }

      // Refresh the fields of the tracks the decks are HOLDING in place (same
      // object identity — play-settle guards compare by reference): a final
      // that landed mid-play updates `assets` for the next load boundary, and
      // Save state stays honest.
      for (const deck of ['a', 'b'] as const) {
        const held = rig.deckTrack(deck);
        if (!held) continue;
        const fresh = queueTracks.find((t) => t.queueItemId === held.queueItemId);
        if (fresh) Object.assign(held, fresh);
      }

      // The Session Cover may change mid-session (the async generated cover
      // landing): refresh lock-screen artwork in place for the audible track.
      if (sessionSnapshot && sessionCoverRef.current !== sessionSnapshot.coverImageId) {
        sessionCoverRef.current = sessionSnapshot.coverImageId;
        const audible = rig.activeTrack();
        if (audible) setMediaMetadata(audible);
      }

      // Resume restores the stored queue POSITION, not just the style, once;
      // every later poll re-anchors the cursor onto the Track the active deck
      // carries, so advance/resume continue from the audible Track.
      cursor.placeCursor(
        {
          currentQueueItemId: snapshot.currentQueueItemId,
          currentTrackId: snapshot.currentTrackId,
          anchorPosition: sessionSnapshot?.anchorPosition,
        },
        rig.activeTrack()?.queueItemId ?? null,
      );

      // Queue replacement invalidates an in-flight preparation whose track is
      // no longer the transition target (the driver re-checks by queue item),
      // and trims the decode cache to current + next.
      retargetNext(rig.activeTrack()?.trackId);

      // Both preparing states recover here: the first startable track flips
      // `loading` AND `waiting` to `ready`. A cursor parked on audio that
      // failed is not startable: the resume path's retry below runs under the
      // honest `waiting`.
      const cursorTrack = cursor.tracks[cursor.idx];
      const nextStatus = snapshotPlayerStatus(
        statusRef.current,
        cursorTrack != null && !isDeadSource(cursorTrack),
      );
      statusRef.current = nextStatus;
      // Session signals stay at their initial values under a Playlist source —
      // the Session shell they drive is not rendered for one.
      const sessionSignals: Partial<PlaybackControllerState> = sessionSnapshot
        ? {
            sessionMode: sessionSnapshot.sessionMode,
            targetDurationMinutes: sessionSnapshot.targetDurationMinutes,
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
            tryAgainTracks: sessionSnapshot.tryAgainTracks,
          }
        : {};
      // Most polls confirm what the player already shows; keep the previous
      // state object then, so the context value stays referentially stable and
      // nothing re-renders (the app shell subscribes on every route).
      // The star and Add-to-Playlist state read the held track the toggles
      // read too, so a retention change made elsewhere can never invert a tap.
      const audible = rig.activeTrack();
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
          active: wantPlayRef.current ? rig.activeTrack() : null,
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
      if (wantPlayRef.current && !rig.activeTrack() && cursor.tracks[cursor.idx]) {
        playOnDeck(rig.activeDeck, cursor.idx);
      }
    },
    [
      applyLoopEvent,
      isDeadSource,
      loopPinned,
      onLoopQueueSnapshot,
      onSectionLoopQueueSnapshot,
      playIndexOrWait,
      playOnDeck,
      retargetNext,
      setMediaMetadata,
      setPlaybackMode,
    ],
  );
  // Ref-backed so cadence probes never restart the polling effect.
  const getIsPlaying = useCallback(() => statusRef.current === 'playing', []);
  // Shuffle traverses the whole Session, so it reads every slot, not the window.
  const refreshQueue = usePlaybackSourceQueue(
    source,
    isLocallyRemoved,
    applyQueueSnapshot,
    getIsPlaying,
    state.playbackMode === 'shuffle',
  );
  pollQueueNowRef.current = refreshQueue;

  /** Buffer-mode carrier watchdog: a rejected `play()` or background error
   * parks the muted carrier element, which would silently drop Android focus
   * AND the timeupdate stream the next transition rides on. Revive it
   * best-effort (re-synced to the buffer clock) and drive the preparation
   * trigger meanwhile — the audible buffer never depended on the carrier. */
  const reviveDeadCarrier = useCallback(() => {
    const deck = rig.activeDeck;
    const el = rig.el(deck);
    if (!el || !el.paused || !wantPlayRef.current || rig.buffers().state(deck) !== 'playing') {
      return;
    }
    rig.syncCarrier(deck);
    void el.play().catch(() => undefined);
    if (rig.blendActive() && Number.isFinite(el.duration) && el.duration > 0) {
      transitions().onTimeUpdate(
        el,
        crossfadeStartSeconds(el.duration, effectiveCrossfadeSeconds()),
      );
    }
  }, [effectiveCrossfadeSeconds, transitions]);

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
      report('position', rig.activeTrack(), rig.position(rig.activeDeck) ?? 0);
      publishPositionState();
      reviveDeadCarrier();
      renewLoopLease();
    }, POSITION_REPORT_MS);
    return () => clearInterval(id);
  }, [state.status, publishPositionState, renewLoopLease, report, reviveDeadCarrier]);

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
    const track = rig.activeTrack();
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
    const track = rig.activeTrack();
    if (track) setMediaMetadata(track);
  }, [audibleTitle, sourceTitle, setMediaMetadata]);

  // A committed Rename reflects immediately: the projection, the
  // held deck tracks, and the queue-sheet state, all without waiting for the
  // next poll (which would confirm the same server truth anyway). The
  // lock-screen republish rides the shared titles-changed effect below.
  const applyTrackTitle = useCallback((trackId: string, title: string) => {
    for (const track of cursor.tracks) {
      if (track.trackId === trackId) track.title = title;
    }
    for (const deck of ['a', 'b'] as const) {
      const held = rig.deckTrack(deck);
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
      const idx = cursor.tracks.findIndex((track) => track.queueItemId === queueItemId);
      const tapped = cursor.tracks[idx];
      if (!tapped || expired(tapped)) return;
      userStartRef.current = true;
      queueTapStartRef.current = true;
      wantPlayRef.current = true;
      patch({ playIntentPending: true });
      void rig.ensureEngine()?.resume();
      if (cursor.traversal.mode === 'loop-track') {
        applyLoopEvent({ type: 'exit' });
      }
      playOnDeck(rig.activeDeck, idx);
    },
    [applyLoopEvent, expired, patch, playOnDeck],
  );

  // The repeat-one surface: assigned EVERY render, after everything it reads
  // exists; the coordinator reads it only at event time (never during render).
  repeatOneDepsRef.current = {
    queue: () => cursor.tracks,
    activeDurationSeconds: () => rig.sample(rig.activeDeck).durationSeconds,
    crossfadeSetting: () => settingsRef.current.crossfadeSeconds,
    syncPreparedTarget: () => transitions().syncTarget(resolveNextTarget()),
    patch,
    // Offline a Section loop still runs, and nothing can buy while it does.
    onHoldFailed: () => {
      if (isOnline()) {
        showPlayerError(
          sourceId,
          'loop-hold',
          'Loop is on, but the generation hold failed — retrying shortly.',
        );
      }
    },
  };

  sectionLoopDepsRef.current = {
    activeDeck: () => rig.activeDeck,
    activeTrack: () => rig.activeTrack(),
    deckEl: (deck) => rig.el(deck),
    buffers: () => rig.buffers(),
    deviceAllows: () => rig.deviceAllowsSectionLoop(),
    muteElement: (deck) => rig.engine()?.setDeckMediaAudible(deck, false),
    abandonEdge,
    carryOnOnElement: (deck, seconds) => {
      const el = rig.el(deck);
      const track = rig.activeTrack();
      rig.enterElementMode(deck);
      if (!el || !track) return;
      el.currentTime = seconds;
      // A carrier can die under a playing buffer, so its pause says nothing here.
      if (wantPlayRef.current) playAndConfirm(deck, el, track, false);
    },
    syncCarrier: (deck) => rig.syncCarrier(deck),
    syncPreparedTarget: () => transitions().syncTarget(resolveNextTarget()),
    holdGeneration: (held) => holdLease('section-loop', held),
    positionMoved: (track, seconds) => {
      report('position', track, seconds);
      publishPositionState();
    },
    patch,
    notice: (message) => showPlayerError(sourceId, 'section-loop', message),
  };

  // An open tool follows the audible Track, and picks up a final that lands.
  const currentQueueItemId = state.currentTrack?.queueItemId ?? null;
  const currentFinalPath = state.currentTrack?.assets.final ?? null;
  useEffect(() => {
    onSectionLoopTrackChanged(currentQueueItemId, currentFinalPath);
  }, [currentQueueItemId, currentFinalPath, onSectionLoopTrackChanged]);

  const canSectionLoop = state.currentTrack != null && rig.deviceAllowsSectionLoop();

  return useMemo<PlaybackControllerApi>(() => {
    // The projection and `state` refresh together (every queue poll writes
    // state), so this index is never staler than the rendered queue length.
    const currentIndex = cursor.tracks.findIndex(
      (t) => t.queueItemId === state.currentTrack?.queueItemId,
    );
    return {
      ...state,
      ...sessionTrackNumbering({
        currentIndex,
        earlierTracks: state.earlierTracks,
        projectionLength: state.queueLength,
        headLeads: cursor.headLeads(),
      }),
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
      applyRetentionAdded,
      toggleFavorite,
      cyclePlaybackMode,
      setPlaybackMode,
      playQueueItem,
      applyTrackTitle,
      loopHeld,
      blendEnabled,
      blendSettled,
      toggleBlend,
      adoptStoredPlaybackSettings,
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
    applyRetentionAdded,
    toggleFavorite,
    cyclePlaybackMode,
    setPlaybackMode,
    playQueueItem,
    applyTrackTitle,
    loopHeld,
    blendEnabled,
    blendSettled,
    toggleBlend,
    adoptStoredPlaybackSettings,
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
