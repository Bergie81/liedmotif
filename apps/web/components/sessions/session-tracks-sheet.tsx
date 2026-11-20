'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Disc3, Pause, Play } from 'lucide-react';
import { countGeneratingAhead, coverArtSrc } from '@/components/player/player-presentation';
import { formatPlayerTime } from '@/components/player/player-time';
import { usePlayerContext } from '@/components/player/player-provider';
import {
  usePlaySessionTrack,
  type TrackPlayTarget,
} from '@/components/player/use-play-session-track';
import { AlertBanner } from '@/components/ui/design-system';
import { LoadMoreButton } from '@/components/ui/load-more-button';
import { LoadingRow, LiedmotifLoader } from '@/components/ui/loading';
import { Sheet, SheetContent, SheetHeader } from '@/components/ui/sheet';
import { cn } from '@/lib/cn';
import { formatGenreLine, formatTrackCount } from './session-list-model';
import { useSessionTracks } from './use-session-tracks';
import { useOpenSessionPlayer } from './use-open-session-player';

type SessionTracksHeader = {
  id: string;
  title: string | null;
  coverImageId: string | null;
  genreTags: string[];
};

type OpenSessionTracks = (session: SessionTracksHeader, opener: HTMLButtonElement) => void;

const OpenSessionTracksContext = createContext<OpenSessionTracks | null>(null);

/** A resumed card can move between sections while its open sheet keeps browsing. */
export function SessionTracksProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionTracksHeader | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // A stable value keeps provider renders from re-rendering every card control beneath it.
  const openTracks = useCallback<OpenSessionTracks>((next, button) => {
    opener.current = button;
    setSession(next);
  }, []);
  return (
    <OpenSessionTracksContext.Provider value={openTracks}>
      <div ref={listRef} tabIndex={-1}>
        {children}
      </div>
      <SessionTracksDialog
        session={session}
        open={session !== null}
        onOpenChange={(open) => {
          if (!open) setSession(null);
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          (opener.current?.isConnected ? opener.current : listRef.current)?.focus();
        }}
      />
    </OpenSessionTracksContext.Provider>
  );
}

export function useOpenSessionTracks(): OpenSessionTracks {
  const open = useContext(OpenSessionTracksContext);
  if (!open) throw new Error('Session track controls require SessionTracksProvider.');
  return open;
}

/** Playback selection stays mounted when the listener dismisses the list. */
export function SessionTracksDialog({
  session,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  session: SessionTracksHeader | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [playError, setPlayError] = useState<string | null>(null);
  const router = useRouter();
  const openRef = useRef(open);
  openRef.current = open;
  function showPlayer() {
    onOpenChange(false);
    router.push('/player');
  }
  const sessionPlayer = useOpenSessionPlayer(showPlayer);
  // A selection that lands after the listener dismissed the sheet plays in place.
  const trackPlayback = usePlaySessionTrack(setPlayError, () => {
    if (openRef.current) showPlayer();
  });
  const [selection, setSelection] = useState<TrackPlayTarget | null>(null);
  function play(track: TrackPlayTarget) {
    if (trackPlayback.busyTrackId !== null || sessionPlayer.busy) return;
    setSelection(track);
    setPlayError(null);
    sessionPlayer.clearError();
    void trackPlayback.playViaSession(track);
  }
  function openPlayer(sessionId: string) {
    if (trackPlayback.busyTrackId !== null) return;
    setPlayError(null);
    void sessionPlayer.open(sessionId);
  }
  const openError =
    sessionPlayer.error?.sessionId === session?.id ? sessionPlayer.error?.message : null;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {open && session ? (
        <SessionTracksSheet
          key={session.id}
          session={session}
          trackPlayback={trackPlayback}
          playError={openError ?? (selection?.originSessionId === session.id ? playError : null)}
          onPlay={(trackId) => play({ id: trackId, originSessionId: session.id })}
          onRetry={() => {
            if (openError) openPlayer(session.id);
            else if (selection) play(selection);
          }}
          onCloseAutoFocus={onCloseAutoFocus}
          openingPlayer={sessionPlayer.busy}
          onOpenPlayer={() => openPlayer(session.id)}
        />
      ) : null}
    </Sheet>
  );
}

function SessionTracksSheet({
  session,
  onCloseAutoFocus,
  trackPlayback,
  playError,
  onPlay,
  onRetry,
  onOpenPlayer,
  openingPlayer,
}: {
  session: SessionTracksHeader;
  trackPlayback: ReturnType<typeof usePlaySessionTrack>;
  playError: string | null;
  onPlay: (trackId: string) => void;
  onRetry: () => void;
  onOpenPlayer: () => void;
  openingPlayer: boolean;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const list = useSessionTracks(session.id);
  const { playback } = usePlayerContext();
  const generatingTracks =
    playback?.session?.id === session.id
      ? countGeneratingAhead({
          items: playback.player.queueItems,
          currentQueueItemId: playback.player.currentTrack?.queueItemId ?? null,
          generatingTracksAhead: playback.player.generatingTracksAhead,
        })
      : 0;
  const scrollRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const { busyTrackId, transportRowPreview } = trackPlayback;
  const busy = busyTrackId !== null || openingPlayer;

  useEffect(() => {
    if (playError) void list.refresh();
  }, [playError, list.refresh]);

  useEffect(() => {
    if (
      !moreRef.current ||
      list.loading ||
      list.error ||
      typeof IntersectionObserver === 'undefined'
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void list.loadMore();
      },
      { root: scrollRef.current, rootMargin: '100px' },
    );
    observer.observe(moreRef.current);
    return () => observer.disconnect();
  }, [list.data?.nextCursor, list.loading, list.error, list.loadMore]);

  const genres = formatGenreLine(list.data?.genreTags ?? session.genreTags);
  // Late siblings can interleave revisions; each changed vibe gets one marker.
  const seenVibes = new Set([1]);
  return (
    <SheetContent
      side="bottom"
      onOpenAutoFocus={() => {
        openerRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }}
      onCloseAutoFocus={
        onCloseAutoFocus ??
        ((event) => {
          event.preventDefault();
          if (openerRef.current?.isConnected) openerRef.current.focus();
        })
      }
      className="flex flex-col overflow-hidden"
    >
      <div className="shrink-0">
        <SheetHeader
          title={session.title ?? 'Untitled Session'}
          action={{
            label: `Open ${session.title ?? 'Untitled Session'} in Player`,
            onClick: onOpenPlayer,
            disabled: busy,
          }}
          description={
            <>
              {genres ? <span className="block">{genres}</span> : null}
              {list.data ? (
                <span className="block">
                  {formatPlayerTime(list.data.totalDurationSeconds)} ·{' '}
                  {formatTrackCount(list.data.total)}
                </span>
              ) : null}
            </>
          }
          closeLabel="Close Session Tracks"
          leading={
            <span className="grid h-16 w-16 shrink-0 self-end place-items-center overflow-hidden rounded-[6px] bg-panel-2">
              {session.coverImageId ? (
                <Image
                  src={coverArtSrc(session.coverImageId, 'thumb')}
                  alt=""
                  width={64}
                  height={64}
                />
              ) : (
                <Disc3 className="h-5 w-5 text-muted" aria-hidden />
              )}
            </span>
          }
        />
      </div>
      <div ref={scrollRef} className="mt-4 min-h-0 overflow-y-auto overscroll-contain">
        {list.error ? (
          <RetryBanner
            message={list.error}
            disabled={list.loading}
            onRetry={() => void list.refresh()}
          />
        ) : null}
        {playError ? <RetryBanner message={playError} disabled={busy} onRetry={onRetry} /> : null}
        {!list.data && !list.error ? <LoadingRow label="Loading tracks…" /> : null}
        {list.data?.total === 0 ? (
          <p className="py-8 text-center text-sm text-muted">No playable tracks yet.</p>
        ) : null}
        <ul aria-label="Session tracks">
          {list.data?.items.map((track) => {
            const revision = track.styleRevision ?? 1;
            const newVibe = !seenVibes.has(revision);
            seenVibes.add(revision);
            const current = transportRowPreview.trackId === track.id;
            const playing = current && transportRowPreview.state === 'playing';
            const title = track.title ?? 'Untitled Track';
            return (
              <li key={track.id}>
                {newVibe ? (
                  <div className="flex items-center gap-2 py-2 font-mono text-[9px] uppercase tracking-[0.16em] text-lamp">
                    <span className="h-px flex-1 bg-lamp/35" aria-hidden />
                    <span>New Vibe from Here</span>
                    <span className="h-px flex-1 bg-lamp/35" aria-hidden />
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => onPlay(track.id)}
                  disabled={busy}
                  aria-label={`${playing ? 'Pause' : 'Play'} ${title}`}
                  aria-current={current ? 'true' : undefined}
                  aria-busy={busyTrackId === track.id}
                  className={cn(
                    'flex min-h-12 w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-panel-2 focus-visible:outline focus-visible:outline-lamp disabled:opacity-60',
                    current && 'bg-lamp/[0.06] text-lamp',
                  )}
                >
                  <TrackRowIcon busy={busyTrackId === track.id} playing={playing} />
                  <span className="min-w-0 flex-1 truncate text-[14.5px] font-semibold">
                    {title}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-dim">
                    {formatPlayerTime(track.durationSeconds)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {list.data?.nextCursor != null ? (
          <div ref={moreRef}>
            <LoadMoreButton
              loading={list.loading}
              onClick={() => void list.loadMore()}
              className="mt-4"
            />
          </div>
        ) : null}
      </div>
      {generatingTracks > 0 ? (
        <div
          role="status"
          className="mt-2 flex shrink-0 items-center gap-2 border-t border-line pt-2 text-[12px] text-muted"
        >
          <LiedmotifLoader size="xs" />
          <span>Preparing {formatTrackCount(generatingTracks)}…</span>
        </div>
      ) : null}
    </SheetContent>
  );
}

function RetryBanner({
  message,
  disabled,
  onRetry,
}: {
  message: string;
  disabled: boolean;
  onRetry: () => void;
}) {
  return (
    <AlertBanner className="mb-4">
      <span>{message}</span>
      <button type="button" className="ml-2 font-semibold" disabled={disabled} onClick={onRetry}>
        Retry
      </button>
    </AlertBanner>
  );
}

function TrackRowIcon({ busy, playing }: { busy: boolean; playing: boolean }) {
  if (busy) return <LiedmotifLoader size="xs" />;
  if (playing) return <Pause className="h-4 w-4 shrink-0 fill-current" aria-hidden />;
  return <Play className="h-4 w-4 shrink-0" aria-hidden />;
}
