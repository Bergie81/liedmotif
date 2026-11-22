'use client';

// The sleeve back (draft 02-player): a vocal Session prints its lyrics on the
// reverse of the cover — same frame, same scanlines, the artwork dimmed behind
// the words. The panel sits on the artwork, so it keeps the night palette in
// both themes — hence the fixed hexes.
// The lit line carries a 2px lamp playhead.
// Instrumental Sessions never render this face.

import { useEffect, useRef, useState } from 'react';
import { Maximize2, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { CoverArt } from './cover-art';
import {
  LYRICS_PHASE_COPY,
  lyricLineInteraction,
  lyricsTimingStatus,
  type LyricLineState,
} from './lyrics-view';
import type { PlaybackSample } from './playback-controller-api';
import { useLyricsSurface } from './use-track-lyrics';

/** The lit line rides in the upper third of the window (draft contract). */
const ACTIVE_LINE_ANCHOR = 0.34;

/** Night-palette line colours: the sung line is lamp-lit, the words still to
 *  come stay bright, and the ones already sung recede. */
const LINE_TONE: Record<LyricLineState, string> = {
  active: 'text-[#ffb25c] [text-shadow:0_0_22px_rgba(255,178,92,0.35)] before:opacity-100',
  next: 'text-[#cfc9dc]',
  past: 'text-[#918aa6]',
};

export function PlayerLyricsPanel({
  trackId,
  open,
  coverImageId,
  getPlaybackSample,
  seekTo,
  onExpand,
  onClose,
}: {
  trackId: string | null;
  /** Whether the sleeve is currently turned to this face. */
  open: boolean;
  coverImageId: string | null;
  getPlaybackSample: () => PlaybackSample;
  seekTo: (seconds: number) => void;
  onExpand: () => void;
  onClose: () => void;
}) {
  const { phase, lines, synced, settled, states } = useLyricsSurface({
    trackId,
    enabled: open,
    getPlaybackSample,
  });
  const activeIndex = states.indexOf('active');

  // The sleeve keeps the sung line in the upper third; it can't be scrolled by
  // hand (the list rides a transform), so auto-scroll and the reader's fingers
  // never fight.
  const windowRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const [scrollY, setScrollY] = useState(0);
  useEffect(() => {
    if (!open || activeIndex < 0) {
      setScrollY(0);
      return;
    }
    const anchor = listRef.current?.querySelector<HTMLElement>('[data-state="active"]');
    const window_ = windowRef.current;
    if (!anchor || !window_) return;
    setScrollY(
      Math.max(0, Math.round(anchor.offsetTop - window_.clientHeight * ACTIVE_LINE_ANCHOR)),
    );
  }, [open, activeIndex, trackId]);

  return (
    <div
      id="lyrics-panel"
      data-testid="lyrics-panel"
      aria-hidden={!open}
      inert={!open}
      className="absolute inset-0 flex flex-col overflow-hidden rounded-[20px] bg-[#0a0810] [backface-visibility:hidden] [transform:rotateY(180deg)]"
    >
      {/* Mirrored: the same artwork seen from behind — what turning the sleeve
          over would actually show. */}
      {/* The 26px blur erases any detail past the thumb rendition, so the
          backdrop never pays for full-size bytes. */}
      <CoverArt
        coverImageId={coverImageId}
        thumb
        className="absolute inset-0 h-full w-full object-cover opacity-70 blur-[26px] [transform:scale(1.15)_scaleX(-1)]"
        fallback={null}
      />
      <div className="absolute inset-0 [background:linear-gradient(180deg,rgba(10,8,16,0.5),rgba(10,8,16,0.72))]" />
      <div className="absolute inset-0 bg-[repeating-linear-gradient(0deg,rgba(255,255,255,0.035)_0_1px,transparent_1px_3px)] mix-blend-overlay" />

      <div className="relative flex items-center justify-between gap-2 px-5 pb-2 pt-4">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-[#ffb25c]">
          Lyrics
        </span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Open Full Lyrics"
            onClick={onExpand}
            className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-[8px] text-[#a79fba] transition-colors duration-150 ease-[ease] hover:bg-[rgba(240,234,222,0.07)] hover:text-[#f0eade]"
          >
            <Maximize2 className="h-[15px] w-[15px]" aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Back to the Cover"
            onClick={onClose}
            className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-[8px] text-[#a79fba] transition-colors duration-150 ease-[ease] hover:bg-[rgba(240,234,222,0.07)] hover:text-[#f0eade]"
          >
            <X className="h-[16px] w-[16px]" aria-hidden />
          </button>
        </span>
      </div>

      {/* Lyrics land at TEXT_SUCCESS, ahead of the audio, so a Track can be
          playing from the stream rung while the words are still arriving. */}
      {phase === 'pending' ? (
        <div className="relative flex min-h-0 flex-1 flex-col justify-center gap-3 px-5 pb-6">
          <span className="inline-flex items-center gap-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-[#ffb25c]">
            <span
              aria-hidden
              className="h-[7px] w-[7px] rounded-full bg-[#ffb25c] motion-safe:animate-dot-gen"
            />
            Writing the words
          </span>
          <p className="text-[11.5px] leading-[1.5] text-[#918aa6]">
            The model writes the text before it sings it, so the words show up here first.
          </p>
        </div>
      ) : null}

      {phase === 'loading' || phase === 'empty' ? (
        <div className="relative flex min-h-0 flex-1 items-center justify-center px-5 pb-6 font-mono text-[9.5px] uppercase tracking-[0.14em] text-[#918aa6]">
          {LYRICS_PHASE_COPY[phase]}
        </div>
      ) : null}

      {phase === 'lines' ? (
        <>
          <div
            ref={windowRef}
            className="relative min-h-0 flex-1 overflow-hidden px-5 [mask-image:linear-gradient(180deg,transparent,#000_14%,#000_80%,transparent)]"
          >
            {/* One line, one seek target. */}
            <ol
              ref={listRef}
              style={{ transform: `translateY(-${scrollY}px)` }}
              className="font-display text-[16.5px] font-semibold leading-[1.4] tracking-[-0.01em] will-change-transform motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-[ease]"
            >
              {lines.map((line, index) =>
                line.kind === 'section' ? (
                  <li key={index} className={index === 0 ? 'pt-0' : 'pt-4'}>
                    <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-[#918aa6]">
                      {line.label}
                    </span>
                  </li>
                ) : (
                  <li key={index}>
                    <button
                      {...lyricLineInteraction(line, states[index]!, synced, seekTo)}
                      className={cn(
                        'relative block w-full py-[5px] text-left transition-colors duration-300 ease-[ease] [-webkit-tap-highlight-color:transparent]',
                        'before:absolute before:left-[-14px] before:top-[9px] before:h-[16px] before:w-[2px] before:rounded-[1px] before:bg-[#ffb25c] before:opacity-0 before:shadow-[0_0_10px_#ffb25c,0_0_26px_rgba(255,178,92,0.28)] before:transition-opacity before:duration-300 before:ease-[ease]',
                        LINE_TONE[states[index]!],
                        !synced && 'pointer-events-none',
                      )}
                    >
                      {line.text}
                    </button>
                  </li>
                ),
              )}
              <li aria-hidden className="h-[38%]" />
            </ol>
          </div>

          <div className="relative px-5 pb-4 pt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-[#918aa6]">
            {lyricsTimingStatus({ synced, settled }).label}
          </div>
        </>
      ) : null}
    </div>
  );
}
