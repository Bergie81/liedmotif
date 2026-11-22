'use client';

// The /player page surface. A Start gesture on Home stashes its in-flight
// request in the session handoff and navigates here at once, so the player
// frame (placeholder cover, connecting narration, Cancel) is visible for the
// whole start round-trip — the request resolves into the live player (the
// handoff engages it, auto-play armed), the headroom-blocked popup, or an
// error card (above the live player when other music plays).
// Any other arrival (nav tab, reload, resume from My Sessions, More Like
// This) reattaches to the cross-route controller when one is live, else
// discovers the active session via diagnostics and never auto-plays
// unprompted. The controller itself lives in the PlayerProvider —
// this page only chooses which session to engage and renders the full-size
// surface.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MoreHorizontal } from 'lucide-react';
import type { SessionSummary } from '@liedmotif/shared';
import { useAppChrome } from '@/components/app-chrome-context';
import { cn } from '@/lib/cn';
import { CreationBlockedDialog } from '@/components/create/creation-blocked-dialog';
import { creationRefusalFor, type CreationRefusal } from '@/components/create/creation-refusal';
import {
  iconButtonClass,
  nowPlayingDetailsClass,
  nowPlayingLayoutClass,
  nowPlayingSpareRowClass,
} from '@/components/ui/design-system';
import { primaryButtonClass, secondaryButtonClass } from '@/components/ui/form-styles';
import { LoadingScreen } from '@/components/ui/loading';
import { PlaceholderCoverMotion } from './placeholder-cover-motion';
import { GenerationBanner } from './generation-banner';
import { NowPlaying } from './now-playing';
import { PlaylistNowPlaying } from './playlist-now-playing';
import type { IncomingSource } from './player-presentation';
import { PlayerHeader } from './player-header';
import { PlayerMobileHeader } from './player-mobile-header';
import { usePlayerContext } from './player-provider';
import { engagedSourceName, type EngagedSource } from './player-provider-model';
import type { PlaybackSample } from './playback-controller-api';
import { progressSlotClass } from './section-loop-bar';
import { TrackProgress } from './track-progress';
import { TrackMetaLine } from './track-meta-line';
import { TransportControls } from './transport-controls';
import {
  cancelPendingStart,
  currentPendingStart,
  takeUnshownStartRefusal,
  type PendingStart,
} from './session-handoff';

/** What the connecting frame narrates while the start request (session setup +
 * the LLM expanding the vibe) is in flight — before any provider stage exists. */
const CONNECTING_COPY = 'Setting the vibe…';

/** The connecting title's staged narration: each phrase swap triggers one
 * decode sweep, so the frame reads as advancing work. Progress never
 * regresses — a long start request holds the last phrase. */
const CONNECTING_PHRASES: readonly string[] = [
  CONNECTING_COPY,
  'Warming up the band…',
  'Humming the first idea…',
  'Sketching melodies…',
  'Choosing instruments…',
  'Laying down the groove…',
  'Finding the hook…',
  'Stacking harmonies…',
  'Polishing the first take…',
];
const CONNECTING_PHRASE_MS = 4000;

function useConnectingPhrase(): string {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const id = window.setInterval(
      () => setIndex((i) => Math.min(i + 1, CONNECTING_PHRASES.length - 1)),
      CONNECTING_PHRASE_MS,
    );
    return () => window.clearInterval(id);
  }, []);
  return CONNECTING_PHRASES[index]!;
}

type View =
  | { kind: 'discovering' }
  | { kind: 'connecting'; startedAt: string }
  | { kind: 'player' }
  | { kind: 'blocked'; refusal: CreationRefusal }
  | { kind: 'failed'; message: string }
  | { kind: 'idle' };

/** Where a resolved start lands once its session has been engaged: the live
 * player (only a session the user just started auto-plays), the
 * headroom-blocked popup (no session was created), or the error card. */
function startedView(result: Awaited<PendingStart['result']>): View {
  if (result.ok) return { kind: 'player' };
  const refusal = creationRefusalFor(result.error);
  if (refusal) return { kind: 'blocked', refusal };
  return { kind: 'failed', message: result.error.message };
}

/** The source the player narrates as on its way: a pending one arming behind
 * the audible one, unless its generation is in trouble, else a Session whose
 * start request is still in flight. */
function incomingSource(input: {
  pendingSource: EngagedSource | null;
  troubled: boolean;
  connecting: boolean;
}): IncomingSource | null {
  if (input.pendingSource) {
    if (input.troubled) return null;
    return {
      noun: input.pendingSource.kind === 'session' ? 'Session' : 'Playlist',
      title: engagedSourceName(input.pendingSource),
    };
  }
  return input.connecting ? { noun: 'Session', title: null } : null;
}

export function PlayerView() {
  const router = useRouter();
  const { engagedSource, playback, pending, startCount, engage, release } = usePlayerContext();
  // The shell refreshes its chrome on this very navigation — join its request
  // instead of firing a second identical one.
  const { fetchChrome } = useAppChrome();
  const [view, setView] = useState<View>({ kind: 'discovering' });
  // The engaged source covers a live controller too (one exists only for an
  // engaged source): at mount it says a source survived navigation, and in the
  // discovery callback it says the user engaged one while the request was in
  // flight.
  const engagedSourceRef = useRef(engagedSource);
  engagedSourceRef.current = engagedSource;
  // Taken once per mount (a ref survives StrictMode's effect re-run, which
  // would otherwise find the slot already emptied).
  const settledRefusal = useRef<Awaited<PendingStart['result']> | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const pending = currentPendingStart();
    if (pending) {
      setView({ kind: 'connecting', startedAt: pending.startedAt });
      // Cancel — the button here, or "Play this instead" anywhere — leaves
      // whatever the user is playing (or nothing) on screen.
      const onCancel = () => {
        if (!cancelled) setView(engagedSourceRef.current ? { kind: 'player' } : { kind: 'idle' });
      };
      pending.signal.addEventListener('abort', onCancel, { once: true });
      void pending.result.then((result) => {
        if (cancelled || pending.signal.aborted) return;
        takeUnshownStartRefusal();
        setView(startedView(result));
      });
      return () => {
        cancelled = true;
        pending.signal.removeEventListener('abort', onCancel);
      };
    }
    if (settledRefusal.current === undefined) settledRefusal.current = takeUnshownStartRefusal();
    const refusal = settledRefusal.current;
    if (refusal) {
      setView(startedView(refusal));
    } else if (engagedSourceRef.current) {
      // A source survived navigation — reattach without a round-trip.
      setView({ kind: 'player' });
    } else {
      void fetchChrome().then((res) => {
        if (cancelled || engagedSourceRef.current) return;
        if (res.ok && res.data.activeSession) {
          engage(res.data.activeSession, { autoplay: false });
          setView({ kind: 'player' });
        } else {
          setView({ kind: 'idle' });
        }
      });
    }
    return () => {
      cancelled = true;
    };
    // `startCount`: a Start begun while this page is mounted is narrated too.
  }, [engage, fetchChrome, startCount]);

  useEffect(() => {
    if (!engagedSource) return;
    setView((current) =>
      current.kind === 'discovering' || current.kind === 'idle' ? { kind: 'player' } : current,
    );
  }, [engagedSource]);

  const showSession = useCallback(
    (session: SessionSummary) => {
      engage(session, { autoplay: false });
      // A Start still in flight keeps its narration and its Cancel.
      setView((current) => (current.kind === 'connecting' ? current : { kind: 'player' }));
    },
    [engage],
  );
  // The Player has nothing of its own to show without music: Home is where a
  // Session starts. Replaced, so Back does not land on a page that leaves again.
  const idle = view.kind === 'idle';
  useEffect(() => {
    if (idle) router.replace('/');
  }, [idle, router]);

  // A stopped Session leaves Now Playing for My Sessions, where it can be
  // resumed; the view stays on the quiet player frame while the navigation
  // lands.
  const showStopped = useCallback(() => {
    release();
    router.push('/sessions');
  }, [release, router]);

  // While a NEW source arms behind the audible one (or a Session's start
  // request is still in flight), the current music keeps playing and the
  // player itself says so on its status line — never a card swap that silences
  // the page. Generation trouble on the incoming session swaps that
  // reassurance for the banner above the player: a "preparing" pulse would
  // over-promise while generation is blocked.
  const troubledPlayer =
    pending?.player && pending.player.generationStatus !== 'ok' ? pending.player : null;
  const incoming = incomingSource({
    pendingSource: pending?.source ?? null,
    troubled: troubledPlayer !== null,
    connecting: view.kind === 'connecting',
  });
  const livePlayer = playback ? (
    <>
      {view.kind === 'connecting' ? (
        <div className="mb-4 flex items-center justify-between gap-4">
          <p className="text-[13.5px] text-muted">Setting up your new session…</p>
          <CancelStartButton />
        </div>
      ) : null}
      {troubledPlayer ? (
        // No action slot: this banner describes the INCOMING session while the
        // one below it keeps playing — a way out here would delete the wrong
        // Session.
        <div className="mb-4" data-testid="session-handoff-notice">
          <GenerationBanner player={troubledPlayer} />
        </div>
      ) : null}
      {playback.session ? (
        <NowPlaying
          key={playback.session.id}
          playback={playback}
          session={playback.session}
          incoming={incoming}
          onSessionChange={showSession}
          onStopped={showStopped}
        />
      ) : playback.source.kind === 'playlist' ? (
        <PlaylistNowPlaying
          key={playback.source.playlist.id}
          playback={playback}
          playlist={playback.source.playlist}
          incoming={incoming}
        />
      ) : null}
    </>
  ) : null;

  switch (view.kind) {
    case 'player':
      // The engaged controller mounts within a tick; render the same quiet
      // frame as discovery rather than flashing an empty state.
      return livePlayer ?? <LoadingScreen pathname="/player" />;
    case 'connecting':
      return livePlayer ?? <ConnectingCard startedAt={view.startedAt} />;
    case 'discovering':
      return <LoadingScreen pathname="/player" />;
    case 'blocked':
      // No Session was created: whatever was playing keeps its player.
      return (
        <>
          {livePlayer ?? <LoadingScreen pathname="/player" />}
          <CreationBlockedDialog
            open
            onOpenChange={(open) => {
              if (!open) setView(engagedSourceRef.current ? { kind: 'player' } : { kind: 'idle' });
            }}
            refusal={view.refusal}
          />
        </>
      );
    case 'failed':
      // The mini player is hidden on /player: music that kept playing through
      // the failed Start keeps its controls only below the card.
      return (
        <>
          <StartFailedCard message={view.message} aboveLivePlayer={livePlayer !== null} />
          {livePlayer}
        </>
      );
    case 'idle':
      // The quiet frame, while the navigation to Home lands.
      return <LoadingScreen pathname="/player" />;
  }
}

/** No clock to sample yet — the connecting frame's bar is purely synthetic. */
const IDLE_SAMPLE: PlaybackSample = {
  positionSeconds: null,
  durationSeconds: null,
  playbackRate: 1,
};

/** The options control the live player will carry, not usable until it arrives. */
const CONNECTING_OPTIONS = (
  <button type="button" disabled aria-label="Session and Track Options" className={iconButtonClass}>
    <MoreHorizontal className="h-[22px] w-[22px]" aria-hidden />
  </button>
);

/** The player frame during the start round-trip — the SAME UI the live player
 * takes over with, so nothing jumps when the session arrives: placeholder
 * cover, the live header and genre rows, every transport control disabled, and
 * the progress bar carrying the connecting narration + synthetic fill anchored
 * on the Start click. */
function ConnectingCard({ startedAt }: { startedAt: string }) {
  const connectingPhrase = useConnectingPhrase();
  return (
    <section
      aria-label="Now Playing"
      data-testid="player-connecting"
      className={nowPlayingLayoutClass}
    >
      <div>
        <PlayerMobileHeader title="Now Playing Your Session" action={CONNECTING_OPTIONS} />
        <div className="relative mx-auto mt-4 aspect-square w-full overflow-hidden rounded-[20px] desk:max-w-[calc(var(--shell-col)-32px)] @split:max-w-none bg-panel-2 shadow-[0_34px_90px_-24px_var(--lamp-glow),0_18px_50px_rgba(0,0,0,0.55)] light:shadow-[0_30px_70px_-26px_rgba(232,143,47,0.35),0_16px_44px_rgba(34,29,48,0.28)]">
          <PlaceholderCoverMotion />
        </div>
      </div>
      <div className={nowPlayingDetailsClass}>
        <PlayerHeader
          statusLabel="Connecting"
          title={connectingPhrase}
          subtitle="Preparing your new session"
          announcement="Connecting: preparing your new session."
          // Narrow screens hide the options slot, so this holds the height the
          // live player's icon row takes over.
          newMusic={<span aria-hidden className={cn(iconButtonClass, 'invisible')} />}
          options={CONNECTING_OPTIONS}
        />
        <TrackMetaLine />
        <div className={cn('mt-4', progressSlotClass)}>
          <TrackProgress
            track={null}
            trackNumber={null}
            trackCount={0}
            getPlaybackSample={() => IDLE_SAMPLE}
            seekTo={() => undefined}
            staged={{ copy: CONNECTING_COPY, submittedAt: startedAt }}
          />
        </div>
        <TransportControls disabled preparing />
        <div className={cn('mt-8 flex justify-center', nowPlayingSpareRowClass)}>
          <CancelStartButton />
        </div>
      </div>
    </section>
  );
}

/** Cancel the Start in flight. The Start never takes over the player; while
 * the vibe is still being set, the server also creates no Session. */
function CancelStartButton() {
  return (
    <button
      type="button"
      data-testid="cancel-start"
      onClick={cancelPendingStart}
      className={secondaryButtonClass}
    >
      Cancel
    </button>
  );
}

function StartFailedCard({
  message,
  aboveLivePlayer,
}: {
  message: string;
  aboveLivePlayer: boolean;
}) {
  // Above the live player, which carries the page's h1.
  const Heading = aboveLivePlayer ? 'h2' : 'h1';
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center gap-2 rounded-card border border-warn/35 bg-warn/[0.06] px-4 text-center',
        aboveLivePlayer ? 'mb-4 py-6' : 'py-16',
      )}
    >
      <Heading className="font-display text-[18px] font-bold text-paper">
        Your Session Didn’t Start
      </Heading>
      <p className="text-[12px] leading-relaxed text-warn">{message}</p>
      <Link href="/" className={cn(primaryButtonClass, 'mt-2')}>
        Try Again
      </Link>
    </div>
  );
}
