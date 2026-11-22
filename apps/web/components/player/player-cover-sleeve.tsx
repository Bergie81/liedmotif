'use client';

// The two-sided cover (draft 02-player): artwork on the front, the Track's
// lyrics printed on the back. The shadow stays on the outer frame so it holds
// still while the card turns; each face carries its own rounded clip. Only the
// face pointing at the reader can be reached or announced — the other one is
// mid-air (inert). A Track with no words gets no tab and no back side — the
// default player is untouched.

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { MicVocal } from 'lucide-react';
import { cn } from '@/lib/cn';
import { PlayerLyricsPanel } from './player-lyrics-panel';
import type { PlaybackControllerApi } from './playback-controller-api';
import { CoverArt } from './cover-art';
import { isPlaceholderCover, presentSwipeNeighbors, type CoverPeek } from './player-presentation';
import { useTrackMedia } from './track-media';
import { COVER_PEEK_GAP_PX, useCoverSwipe } from './use-cover-swipe';

type CoverSleevePlayer = Pick<
  PlaybackControllerApi,
  | 'currentTrack'
  | 'getPlaybackSample'
  | 'seekTo'
  | 'sessionCoverImageId'
  | 'peekNeighbors'
  | 'skip'
  | 'previous'
>;

export function PlayerCoverSleeve({
  player,
  session,
  coverImageId,
  lyricsAvailable,
  onExpandLyrics,
  children,
}: {
  player: CoverSleevePlayer;
  /** The Session whose Cover a swiped-to Track shows; null for any other source,
   *  whose Tracks each show their own art. */
  session: { coverImageId: string | null } | null;
  coverImageId: string | null;
  /** Whether the current Track has words — anything else renders front-only. */
  lyricsAvailable: boolean;
  /** Opens the full Lyrics sheet (owned by the parent, shared with the options row). */
  onExpandLyrics: () => void;
  /** The front face's content: the artwork. */
  children: ReactNode;
}) {
  const trackId = player.currentTrack?.trackId ?? null;
  const getSwipeNeighbors = () => presentSwipeNeighbors(player, session);
  const [flipped, setFlipped] = useState(false);
  // A flip survives a Track advance (the panel refetches), but a Track with no
  // words turns the cover back.
  useEffect(() => {
    if (!lyricsAvailable) setFlipped(false);
  }, [lyricsAvailable]);
  const frontRef = useRef<HTMLDivElement>(null);
  const media = useTrackMedia();
  const getNeighborsRef = useRef(getSwipeNeighbors);
  useEffect(() => {
    getNeighborsRef.current = getSwipeNeighbors;
  });
  // Fetch the neighbors' artwork as each Track starts, so a swipe reveals it
  // already loaded instead of filling in mid-drag.
  useEffect(() => {
    if (!trackId) return;
    const { next, previous } = getNeighborsRef.current();
    for (const peek of [next, previous]) {
      const src = peek ? media.coverSrc(peek.coverImageId) : null;
      if (src) new Image().src = src;
    }
  }, [trackId, media]);
  // The back face scrolls and seeks lyrics, so only the artwork swipes: left is
  // Skip, right is Previous.
  const swipe = useCoverSwipe({
    enabled: !flipped,
    getNeighbors: getSwipeNeighbors,
    artworkReady: (landing) =>
      frontShows(frontRef, landing.coverImageId, media.coverSrc(landing.coverImageId)),
    onNext: player.skip,
    onPrevious: player.previous,
  });

  return (
    // On desktop the page has room beside the cover, so a swipe's neighbors
    // are clipped to the cover's slot instead of showing across the layout
    // (on mobile the viewport edge already hides them). The clip is held only
    // during a swipe because it also cuts the shadow's sideways glow.
    <div className={cn(swipe.neighbors && 'desk:[clip-path:inset(-200px_0)]')}>
      <div
        data-testid="player-cover"
        {...swipe.handlers}
        className="relative mx-auto mt-4 aspect-square w-full touch-pan-y desk:max-w-[calc(var(--shell-col)-32px)] @split:max-w-none select-none rounded-[20px] shadow-[0_34px_90px_-24px_var(--lamp-glow),0_18px_50px_rgba(0,0,0,0.55)] [perspective:1600px] light:shadow-[0_30px_70px_-26px_rgba(232,143,47,0.35),0_16px_44px_rgba(34,29,48,0.28)]"
      >
        {swipe.neighbors?.previous ? (
          <NeighborCover peek={swipe.neighbors.previous} side="right" />
        ) : null}
        {swipe.neighbors?.next ? <NeighborCover peek={swipe.neighbors.next} side="left" /> : null}
        <div
          className={cn(
            'relative h-full w-full [transform-style:preserve-3d] motion-safe:transition-transform motion-safe:duration-[560ms] motion-safe:ease-[cubic-bezier(0.22,0.8,0.28,1)]',
            flipped && '[transform:rotateY(180deg)]',
          )}
        >
          <div
            ref={frontRef}
            aria-hidden={flipped}
            inert={flipped}
            className="absolute inset-0 overflow-hidden rounded-[20px] bg-panel-2 [backface-visibility:hidden] after:pointer-events-none after:absolute after:inset-0 after:bg-[repeating-linear-gradient(0deg,rgba(255,255,255,0.035)_0_1px,transparent_1px_3px)] after:mix-blend-overlay"
          >
            {children}
            {/* The tab sits on the cover, so the reverse side is offered
              without adding a fourth control to the action row. It rides the
              front face and turns away with it. */}
            {lyricsAvailable ? (
              <button
                type="button"
                data-testid="lyrics-tab"
                aria-expanded={flipped}
                aria-controls="lyrics-panel"
                onClick={() => setFlipped(true)}
                className="absolute bottom-3 right-3 z-[3] inline-flex items-center gap-2 rounded-[7px] border border-line-2 [background:rgba(10,8,16,0.78)] p-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[#a79fba] backdrop-blur-[6px] transition-[color,border-color] duration-150 ease-[ease] hover:border-lamp/45 hover:text-[#f0eade]"
              >
                <MicVocal className="h-[13px] w-[13px]" aria-hidden />
                Lyrics
              </button>
            ) : null}
          </div>

          {lyricsAvailable || flipped ? (
            <PlayerLyricsPanel
              trackId={trackId}
              open={flipped}
              coverImageId={coverImageId}
              getPlaybackSample={player.getPlaybackSample}
              seekTo={player.seekTo}
              onExpand={onExpandLyrics}
              onClose={() => setFlipped(false)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** About a second of frames: the swipe hook stops waiting by then anyway. */
const ARTWORK_CHECK_FRAMES = 60;

/** Settles once the front face shows the landing artwork: the placeholder
 *  scene, or the cover image at its `src`, decoded. The step's render can land
 *  frames after the swipe, and decoding the image still showing would settle
 *  at once, so the front is checked every frame first. A cover with no image
 *  (`src` null) shows its fallback at once. */
async function frontShows(
  front: RefObject<HTMLElement | null>,
  coverImageId: string | null,
  src: string | null,
): Promise<void> {
  if (src === null) return;
  const placeholder = isPlaceholderCover(coverImageId);
  for (let frame = 0; frame < ARTWORK_CHECK_FRAMES; frame++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (placeholder && front.current?.querySelector('[data-testid="placeholder-cover-motion"]')) {
      return;
    }
    const img = front.current?.querySelector('img');
    if (img?.getAttribute('src') === src) return img.decode();
  }
}

/** A neighbor Track's artwork waiting beside the cover; it rides the swipe
 *  and only exists during one. `side` is the edge it is offset from. */
function NeighborCover({ peek, side }: { peek: CoverPeek; side: 'left' | 'right' }) {
  return (
    <div
      aria-hidden
      data-testid="cover-peek"
      className="absolute top-0 h-full w-full overflow-hidden rounded-[20px] bg-panel-2"
      style={{ [side]: `calc(100% + ${COVER_PEEK_GAP_PX}px)` }}
    >
      <CoverArt
        coverImageId={peek.coverImageId}
        eager
        className="h-full w-full object-cover"
        fallback={null}
      />
    </div>
  );
}
