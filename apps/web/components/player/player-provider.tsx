'use client';

// Cross-route audio ownership. The player controller — the audio engine, both
// deck elements, and all playback state — must outlive any one page, so this
// provider hosts it ABOVE the App Router's page swap: the /player surface and
// the mini player (sidebar rail on desktop, bottom bar on mobile) are both
// mere consumers, and navigation never unmounts the decks.
//
// The provider plays one Playback source — a Session or a Playlist
// — and sources hand off audibly (the dual-host crossfade): engaging a
// different source while one is audible mounts the new controller MUTED
// alongside it (`pending`); the old source keeps playing while the new one
// arms, and once its first track is audible the provider crossfades the two
// hosts' master outputs and unmounts the drained one. Engaging over silence
// swaps directly, and re-engaging the same source only refreshes the summary
// in place. The deterministic transition rules live in `player-provider-model`.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  PlaylistMemberItem,
  PlaylistSummaryItem,
  ChangeVibeIntentInput,
  SessionSummary,
} from '@liedmotif/shared';
import type { ChangeVibeOptions } from '@/lib/api-client';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  abandonPendingPlayback,
  beginHandoffDrain,
  endHandoffDrain,
  engagePlayback,
  engagedSourceId,
  engagedSourceName,
  handoffFadeDurationMs,
  handoffFadeGains,
  idlePlaybackState,
  pairLivePlayback,
  pendingHandoffAction,
  promotePendingPlayback,
  releasePlayback,
  sleepTimerTargets,
  type EngagedSource,
  type HostedController,
  type LivePlayback,
  type PlaybackEntry,
  type ProviderPlaybackState,
} from './player-provider-model';
import { primePlayerAutoplay } from './autoplay-arm';
import { playlistTracksToPlayable } from './playlist-playable';
import type { PlayerControllerSource } from './playback-controller-api';
import { cancelPendingStart, currentPendingStart } from './session-handoff';
import type { SleepTimerControl } from './sleep-timer';
import { usePlaybackController } from './use-playback-controller';
import { useTrackMedia } from './track-media';
import { useSleepTimer } from './use-sleep-timer';
import { useVibeChangeRequest, type VibeChangeState } from './use-vibe-change-request';

export type { EngagedSource, LivePlayback } from './player-provider-model';
export type { VibeChangeState } from './use-vibe-change-request';

/** How often the handoff crossfade re-steps the two master outputs. */
const HANDOFF_FADE_TICK_MS = 50;

/** The stable half of the player api: every member is a `useCallback` whose
 * identity never changes after mount, so the context value never changes and
 * an action-only consumer (card grids, search rows, seeding hooks) is never
 * re-rendered by the 1–4 Hz controller state churn. */
export interface PlayerActionsValue {
  /** Engage a session for playback. Same session id = refresh the summary in
   * place (the controller keeps playing); a different id hands playback off —
   * audibly via the crossfade when something is playing, directly otherwise. */
  engage: (session: SessionSummary, options?: { autoplay?: boolean }) => void;
  /** Engage a Playlist (Play / row tap). Always a fresh start — a Playlist has
   * no stored position, so engaging one that is already playing restarts it.
   * `foreign` marks another owner's In-Lounge playlist (the visitor scope). */
  engagePlaylist: (
    playlist: PlaylistSummaryItem,
    items: PlaylistMemberItem[],
    startTrackId?: string | null,
    options?: { foreign?: boolean },
  ) => void;
  /** Engage an Available-offline collection from this device (the Offline
   * Library): a fresh start, like a Playlist, that reaches the server for
   * nothing. */
  engageOffline: (source: Omit<Extract<EngagedSource, { kind: 'offline' }>, 'kind'>) => void;
  /** Drop the engaged source and dispose the controller (Stop). */
  release: () => void;
  /** Every Start tap begins here, synchronously inside the tap: primes the
   * autoplay engine on its gesture, and stops music that is not playing. Quiet
   * music has nothing to keep alive while the new Session sets up (the Start
   * stops the prior Active Session server-side anyway), so the player narrates
   * the Start as if nothing were engaged rather than showing that music
   * frozen. Playing music keeps playing until the new Session is ready. */
  beginStart: () => void;
  /** Every tap that plays other music begins here, synchronously inside the
   * tap and BEFORE any request that resumes or creates a Session — those
   * change the Active Session server-side, so asking after them is too late.
   * Primes the autoplay engine on the tap's gesture, then asks before the
   * music replaces a Start still setting the vibe. Resolves true at once when
   * no Start is in flight; otherwise true only once the listener chose "Play
   * this instead" (the Start is then cancelled). */
  beginOtherMusic: () => Promise<boolean>;
  /** Fire-and-forget Change Vibe: the overlay closes at once and this request
   * runs at provider scope. Single-flight; success refreshes the engaged
   * session summary in place, failure lands in `vibeChange.error`. A caller
   * that does wait gets whether the change was saved, or null when another
   * change was in flight and this one was dropped. */
  submitChangeVibe: (
    sessionId: string,
    input: ChangeVibeIntentInput | undefined,
    options: ChangeVibeOptions,
  ) => Promise<boolean> | null;
}

export interface PlayerContextValue extends PlayerActionsValue {
  /** The source requested by the user, available while its controller is
   * mounting and before `playback` can pair with the hosted publication. */
  engagedSource: EngagedSource | null;
  /** The live cross-route controller, or null while nothing is engaged. */
  playback: LivePlayback | null;
  /** A source engaged while another was audible: mounted muted, arming
   * toward its first audible track (the provider crossfades then). The
   * player api is null until its controller publishes. */
  pending: { source: EngagedSource; player: LivePlayback['player'] | null } | null;
  /** The Change Vibe request narration (see {@link VibeChangeState}). */
  vibeChange: VibeChangeState;
  sleepTimer: SleepTimerControl;
  /** Counts the Starts begun in this tab. A Start begun while /player is on
   * screen navigates to the page already mounted, which narrates it on this. */
  startCount: number;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);
const PlayerActionsContext = createContext<PlayerActionsValue | null>(null);

export function usePlayerContext(): PlayerContextValue {
  const value = useContext(PlayerContext);
  if (!value) throw new Error('usePlayerContext requires a PlayerProvider ancestor');
  return value;
}

/** The actions alone — subscribe here when a surface never reads playback
 * state, so the volatile state context cannot re-render it. */
export function usePlayerActions(): PlayerActionsValue {
  const value = useContext(PlayerActionsContext);
  if (!value) throw new Error('usePlayerActions requires a PlayerProvider ancestor');
  return value;
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [model, setModel] = useState<ProviderPlaybackState>(idlePlaybackState);
  // Every mounted host's publication, keyed by source id (up to three hosts
  // live during a handoff: draining, entry, pending).
  const [hosted, setHosted] = useState<Record<string, HostedController>>({});
  const hostedRef = useRef(hosted);
  hostedRef.current = hosted;
  const modelRef = useRef(model);
  modelRef.current = model;

  const publish = useCallback((sourceId: string, controller: HostedController | null) => {
    setHosted((current) => {
      if (controller) return { ...current, [sourceId]: controller };
      if (!(sourceId in current)) return current;
      const next = { ...current };
      delete next[sourceId];
      return next;
    });
  }, []);

  // Whether a new source must hand off audibly (arm behind the entry) or may
  // replace it outright.
  const entryAudible = useCallback(() => {
    const entry = modelRef.current.entry;
    return (
      entry != null && hostedRef.current[engagedSourceId(entry.source)]?.player.status === 'playing'
    );
  }, []);

  const engageSource = useCallback(
    (source: EngagedSource, autoplay: boolean) => {
      // Resolved OUTSIDE the updater — state updaters must stay pure/replayable.
      const audible = entryAudible();
      setModel((current) => engagePlayback(current, source, autoplay, audible));
      // Re-engaging an already-hosted source refreshes the summary in place — a
      // Change Vibe rides exactly this path, so have its live controller observe
      // the server Queue now rather than waiting out the adaptive poll delay.
      hostedRef.current[engagedSourceId(source)]?.player.refreshQueue();
    },
    [entryAudible],
  );

  const engage = useCallback(
    (session: SessionSummary, options?: { autoplay?: boolean }) => {
      engageSource({ kind: 'session', session }, options?.autoplay ?? false);
    },
    [engageSource],
  );

  /** Engage a source that has no stored position (a Playlist, an offline
   * collection) from an explicit Play gesture. */
  const engageFresh = useCallback(
    (source: EngagedSource) => {
      // Playlist playback mounts a fresh host after this user gesture. Unlock
      // its AudioContext now so an audible Session can fade into real audio,
      // not a media element routed through a suspended graph.
      primePlayerAutoplay();
      // A Playlist Play is always an explicit gesture — auto-start is correct,
      // and a re-Play of the already-engaged playlist restarts it (no stored
      // position) by dropping the old host first.
      const id = engagedSourceId(source);
      const isThis = (slot: PlaybackEntry | null) =>
        slot != null && engagedSourceId(slot.source) === id;
      const { entry, pending, draining } = modelRef.current;
      if (isThis(entry) || isThis(pending) || isThis(draining)) {
        // Its host keeps the old position and whatever level a handoff left it
        // at, so drop the host wherever it sits. A source fading out under a
        // restarted entry ends with its old host instead of re-fading from full.
        setModel((current) => ({
          entry: isThis(current.entry) ? null : current.entry,
          pending: isThis(current.pending) ? null : current.pending,
          draining: isThis(current.entry) || isThis(current.draining) ? null : current.draining,
        }));
        // The host unmounts on this state; re-engage next tick with fresh state.
        setTimeout(() => engageSource(source, true), 0);
        return;
      }
      engageSource(source, true);
    },
    [engageSource],
  );

  const engagePlaylist = useCallback(
    (
      playlist: PlaylistSummaryItem,
      items: PlaylistMemberItem[],
      startTrackId?: string | null,
      options?: { foreign?: boolean },
    ) =>
      engageFresh({
        kind: 'playlist',
        playlist,
        items,
        startTrackId: startTrackId ?? null,
        foreign: options?.foreign ?? false,
      }),
    [engageFresh],
  );

  const engageOffline = useCallback<PlayerActionsValue['engageOffline']>(
    (source) => engageFresh({ kind: 'offline', ...source }),
    [engageFresh],
  );

  // The ask is the only place other music cancels a Start: an engage landing
  // late (a resume answered after a newer Start tap) must not cancel it.
  // One question open at a time: a newer ask answers the older one "no".
  const otherMusicAnswer = useRef<((ok: boolean) => void) | null>(null);
  const [askingOtherMusic, setAskingOtherMusic] = useState(false);
  const answerOtherMusic = useCallback((ok: boolean) => {
    if (ok) cancelPendingStart();
    otherMusicAnswer.current?.(ok);
    otherMusicAnswer.current = null;
    setAskingOtherMusic(false);
  }, []);
  const beginOtherMusic = useCallback((): Promise<boolean> => {
    primePlayerAutoplay();
    const start = currentPendingStart();
    if (!start) return Promise.resolve(true);
    otherMusicAnswer.current?.(false);
    setAskingOtherMusic(true);
    return new Promise<boolean>((resolve) => {
      otherMusicAnswer.current = resolve;
      // A Start that settles while the question is open has decided it: its
      // Session plays (or its error shows), so the tap is dropped.
      void start.result.then(() => {
        if (otherMusicAnswer.current === resolve) answerOtherMusic(false);
      });
    });
  }, [answerOtherMusic]);

  const sleepTimer = useSleepTimer(() =>
    sleepTimerTargets(modelRef.current).flatMap((id) => hostedRef.current[id]?.player ?? []),
  );
  const cancelSleepTimer = sleepTimer.cancel;

  // Stop silences everything now: a pending source survives as the new entry
  // (the user stopped the OLD music, not the source they just asked for) but
  // its auto-start disarms — it waits at Ready, unmuted for a later resume,
  // instead of blaring later.
  const release = useCallback(() => {
    const pending = modelRef.current.pending;
    if (pending) {
      const player = hostedRef.current[engagedSourceId(pending.source)]?.player;
      player?.pause();
      player?.setOutputVolume(1);
    }
    // Stop ends the listening the timer was set for; a surviving pending
    // source starts without one.
    cancelSleepTimer();
    setModel(releasePlayback);
  }, [cancelSleepTimer]);

  const [startCount, setStartCount] = useState(0);
  // Unlike Stop, an arming handoff goes too: the new Start replaces it.
  const beginStart = useCallback(() => {
    primePlayerAutoplay();
    if (!entryAudible()) setModel(idlePlaybackState);
    setStartCount((count) => count + 1);
  }, [entryAudible]);

  // A restyled summary lands ONLY while that session is still the engaged
  // source: a success arriving after the user switched to another source must
  // never yank playback back.
  const applyRestyledSession = useCallback(
    (session: SessionSummary) => {
      const entry = modelRef.current.entry;
      if (entry?.source.kind === 'session' && entry.source.session.id === session.id) {
        engageSource({ kind: 'session', session }, false);
      }
    },
    [engageSource],
  );

  // Mounted here — not in the page tree — so navigating never drops the Change
  // Vibe request: the round-trip (LLM adjustment included) keeps running and
  // the pending/error state stays visible wherever the player renders.
  const { vibeChange, submitChangeVibe } = useVibeChangeRequest(applyRestyledSession);

  const entryHosted = model.entry ? (hosted[engagedSourceId(model.entry.source)] ?? null) : null;
  const pendingHosted = model.pending
    ? (hosted[engagedSourceId(model.pending.source)] ?? null)
    : null;

  // The arming pending source's next move: crossfade once it is audible over
  // an audible entry, promote silently over a quiet one, abandon a session
  // that stopped before ever playing. Recoverable generation degrades keep
  // waiting — the entry keeps playing meanwhile.
  useEffect(() => {
    if (!model.pending) return;
    const action = pendingHandoffAction({
      pendingStatus: pendingHosted?.player.status ?? null,
      pendingSessionStatus: pendingHosted?.player.sessionStatus ?? 'active',
      entryStatus: entryHosted?.player.status ?? null,
    });
    if (action === 'begin-drain') setModel(beginHandoffDrain);
    else if (action === 'promote' || action === 'promote-paused') {
      // A silent promotion is the one path the fade never touches: the host
      // mounted muted, so unmute here (paused promotions stay silent until
      // the user resumes — at full level).
      if (action === 'promote-paused') pendingHosted?.player.pause();
      pendingHosted?.player.setOutputVolume(1);
      setModel(promotePendingPlayback);
    } else if (action === 'abandon') setModel(abandonPendingPlayback);
  }, [model.pending, pendingHosted, entryHosted]);

  // The crossfade itself: equal-power ramps on both hosts' whole outputs. The
  // controllers are resolved ONCE (their volume handles are stable callbacks);
  // cleanup leaves the surviving side at full level whatever ended the fade.
  const drainingId = model.draining ? engagedSourceId(model.draining.source) : null;
  const entryId = model.entry ? engagedSourceId(model.entry.source) : null;
  useEffect(() => {
    if (!entryId) return;
    // Outside a fade the entry plays at full level: a source re-engaged while
    // it was fading out would otherwise keep its host at the mid-fade level.
    if (!drainingId) {
      hostedRef.current[entryId]?.player.setOutputVolume(1);
      return;
    }
    const incoming = hostedRef.current[entryId]?.player ?? null;
    const outgoing = hostedRef.current[drainingId]?.player ?? null;
    // The blend setting governs source handoffs too: off = an immediate hard
    // cut. The incoming (surviving) host's view decides; both hosts read the
    // same persisted setting. Its fetch must have SETTLED first — a host that
    // hands off while still on the default would blend past a saved
    // `blendEnabled: false`, which is the race the engine's own gate exists
    // to close.
    const durationMs = handoffFadeDurationMs(
      incoming ? incoming.blendSettled && incoming.blendEnabled : true,
    );
    const startedAt = performance.now();
    const step = () => {
      const fade = handoffFadeGains(performance.now() - startedAt, durationMs);
      incoming?.setOutputVolume(fade.incoming);
      outgoing?.setOutputVolume(fade.outgoing);
      if (fade.done) setModel(endHandoffDrain);
    };
    // One immediate step so a hard cut lands now, not a tick later.
    step();
    const id = setInterval(step, HANDOFF_FADE_TICK_MS);
    return () => {
      clearInterval(id);
      incoming?.setOutputVolume(1);
    };
  }, [drainingId, entryId]);

  const playback = useMemo(
    () => pairLivePlayback(model.entry, entryHosted),
    [model.entry, entryHosted],
  );
  const engagedSource = model.entry?.source ?? null;
  const pending = useMemo(
    () =>
      model.pending
        ? { source: model.pending.source, player: pendingHosted?.player ?? null }
        : null,
    [model.pending, pendingHosted],
  );
  const actions = useMemo<PlayerActionsValue>(
    () => ({
      engage,
      engagePlaylist,
      engageOffline,
      release,
      beginStart,
      beginOtherMusic,
      submitChangeVibe,
    }),
    [engage, engagePlaylist, engageOffline, release, beginStart, beginOtherMusic, submitChangeVibe],
  );
  const value = useMemo<PlayerContextValue>(
    () => ({ engagedSource, playback, pending, vibeChange, sleepTimer, startCount, ...actions }),
    [engagedSource, playback, pending, vibeChange, sleepTimer, startCount, actions],
  );

  return (
    <>
      <PlayerActionsContext.Provider value={actions}>
        <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>
      </PlayerActionsContext.Provider>
      {askingOtherMusic ? (
        <ConfirmDialog
          heading="Your new Session is currently starting"
          body="Play this instead and cancel your new Session?"
          confirmLabel="Play this instead"
          cancelLabel="Keep starting"
          onConfirm={() => answerOtherMusic(true)}
          onClose={() => answerOtherMusic(false)}
        />
      ) : null}
      {(['draining', 'entry', 'pending'] as const).map((role) => {
        const entry = model[role];
        return entry ? (
          <PlayerHost
            key={engagedSourceId(entry.source)}
            entry={entry}
            role={role}
            publish={publish}
          />
        ) : null;
      })}
    </>
  );
}

/** Mounts ONE controller (and the deck elements the engine binds) for an
 * engaged source, outside the page tree. Keyed by source id — a promotion
 * (pending → entry) keeps the same key, so the controller and its audio
 * survive; only the role-derived flags change. */
function PlayerHost({
  entry,
  role,
  publish,
}: {
  entry: PlaybackEntry;
  role: 'entry' | 'pending' | 'draining';
  publish: (sourceId: string, controller: HostedController | null) => void;
}) {
  const { source } = entry;
  const sourceId = engagedSourceId(source);
  const coldStartBeganAt = useRef(new Date().toISOString()).current;
  const media = useTrackMedia();
  // Stable per engagement: the controller applies a playlist's membership as
  // one snapshot, keyed on this object's identity.
  const controllerSource = useMemo((): PlayerControllerSource => {
    switch (source.kind) {
      case 'session':
        return { kind: 'session', sessionId: source.session.id };
      case 'playlist':
        return {
          kind: 'playlist',
          playlistId: source.playlist.id,
          tracks: playlistTracksToPlayable(source.items),
          startTrackId: source.startTrackId,
        };
      case 'offline':
        return {
          kind: 'playlist',
          playlistId: source.key,
          tracks: source.tracks,
          startTrackId: source.startTrackId,
          offline: true,
        };
    }
  }, [source]);
  const player = usePlaybackController(controllerSource, {
    ...(source.kind === 'session'
      ? {
          generationStatus: source.session.generationStatus,
          generationStatusScope: source.session.generationStatusScope,
          statusMessageSafe: source.session.statusMessageSafe,
          sourceTitle: source.session.title,
          coverImageId: source.session.coverImageId,
        }
      : {
          // Playlist metadata: the playlist names the lock screen; no shared
          // cover, so per-track art always wins.
          sourceTitle: engagedSourceName(source),
          coverImageId: null,
        }),
    artwork: media.artwork,
    autoplay: entry.autoplay,
    // A pending host arms silently; the handoff ramp raises it.
    initialOutputVolume: role === 'pending' ? 0 : 1,
    // Exactly one host owns the lock screen: the visible entry.
    mediaSessionEnabled: role === 'entry',
  });

  useEffect(() => {
    publish(sourceId, { sourceId, player, coldStartBeganAt });
  }, [coldStartBeganAt, publish, player, sourceId]);

  useEffect(() => () => publish(sourceId, null), [publish, sourceId]);

  return (
    <>
      <audio ref={player.deckARef} data-testid="deck-a" preload="auto" hidden />
      <audio ref={player.deckBRef} data-testid="deck-b" preload="auto" hidden />
    </>
  );
}
