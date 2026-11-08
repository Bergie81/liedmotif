'use client';

// The Lyrics sheet (draft 02-player, "the long read"): the cover panel is for
// following along; this is for reading the whole song and seeing where each
// line sits in the Track. Controlled by the parent — it opens from the sleeve
// panel's expand button and from the Session options row, so two sheets never
// stack. Manually scrollable, so unlike the sleeve it never auto-scrolls.

import { Info } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Sheet, SheetContent, SheetHeader } from '@/components/ui/sheet';
import { formatPlayerTime } from './player-time';
import {
  LYRICS_PHASE_COPY,
  lyricLineInteraction,
  lyricsTimingStatus,
  type LyricLineState,
  type LyricsTimingStatus,
} from './lyrics-view';
import type { PlaybackSample } from './playback-controller-api';
import { useLyricsSurface } from './use-track-lyrics';

/** The long read runs on the theme palette: only the sung line is lamp-lit. */
const LINE_TONE: Record<LyricLineState, string> = {
  active: 'text-lamp before:opacity-100',
  past: 'text-dim',
  next: 'text-muted',
};

/** One status card above the words; the lamp tone carries the pulsing
 *  generation dot ("still being produced"), the neutral tone a plain info mark. */
function LyricsStatusCard({
  tone,
  title,
  body,
}: {
  tone: LyricsTimingStatus['tone'];
  title: string;
  body: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        'mt-4 flex items-start gap-2.5 rounded-card-sm border px-4 py-3 text-[13.5px]',
        tone === 'lamp' ? 'border-lamp/35 bg-lamp/[0.05]' : 'border-line-2 bg-[var(--control-bg)]',
      )}
    >
      {tone === 'lamp' ? (
        <span
          aria-hidden
          className="mt-[6px] h-[7px] w-[7px] shrink-0 rounded-full bg-lamp motion-safe:animate-dot-gen"
        />
      ) : (
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
      )}
      <div className="min-w-0">
        <p className="font-semibold">{title}</p>
        <p className="text-[12px] leading-relaxed text-muted">{body}</p>
      </div>
    </div>
  );
}

export function PlayerLyricsSheet({
  open,
  onOpenChange,
  trackId,
  getPlaybackSample,
  seekTo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trackId: string | null;
  getPlaybackSample: () => PlaybackSample;
  seekTo: (seconds: number) => void;
}) {
  const { phase, lines, synced, settled, states } = useLyricsSurface({
    trackId,
    enabled: open,
    getPlaybackSample,
  });
  const timing = lyricsTimingStatus({ synced, settled });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="flex flex-col">
        <SheetHeader
          title="Lyrics"
          description={phase === 'lines' && synced ? 'Tap a line to jump there.' : null}
        />

        <div className="-mx-5 mt-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-5">
          {phase === 'lines' && !synced && timing.detail ? (
            <LyricsStatusCard tone={timing.tone} title={timing.label} body={timing.detail} />
          ) : null}

          {phase === 'pending' ? (
            <LyricsStatusCard
              tone="lamp"
              title="Writing the words"
              body="They usually show up before the audio finishes."
            />
          ) : null}

          {phase === 'loading' || phase === 'empty' ? (
            <p className="mt-6 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-dim">
              {LYRICS_PHASE_COPY[phase]}
            </p>
          ) : null}

          {/* Section tags come back from the model in the lyric text ([Verse],
              [Chorus]); they are the song's real structure, so they label the
              list instead of being stripped. */}
          {phase === 'lines' ? (
            <ol className="mt-4 font-display text-[16.5px] font-semibold leading-[1.45] tracking-[-0.01em]">
              {lines.map((line, index) =>
                line.kind === 'section' ? (
                  <li
                    key={index}
                    className={cn('flex items-center gap-3 pb-1', index !== 0 && 'pt-5')}
                  >
                    <span className="font-mono text-[9.5px] uppercase tracking-[0.2em] text-dim">
                      {line.label}
                    </span>
                    <span
                      aria-hidden
                      className="h-px flex-1 bg-[repeating-linear-gradient(90deg,var(--line-2)_0_1px,transparent_1px_7px)]"
                    />
                  </li>
                ) : (
                  <li key={index}>
                    <button
                      {...lyricLineInteraction(line, states[index]!, synced, seekTo)}
                      className={cn(
                        'relative grid w-full grid-cols-[1fr_auto] items-baseline gap-4 rounded-[10px] px-2 py-[7px] text-left transition-colors duration-300 ease-[ease] [-webkit-tap-highlight-color:transparent] hover:bg-[var(--control-bg-hover)]',
                        'before:absolute before:left-0 before:top-[11px] before:h-[18px] before:w-[2px] before:rounded-[1px] before:bg-lamp before:opacity-0 before:shadow-[0_0_10px_var(--lamp),0_0_26px_var(--lamp-glow)] before:transition-opacity before:duration-300 before:ease-[ease]',
                        LINE_TONE[states[index]!],
                        !synced && 'pointer-events-none',
                      )}
                    >
                      <span>{line.text}</span>
                      {synced && line.timeSeconds !== null ? (
                        <span className="font-mono text-[10px] tracking-[0.06em] tabular-nums opacity-70">
                          {formatPlayerTime(line.timeSeconds)}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ),
              )}
            </ol>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
