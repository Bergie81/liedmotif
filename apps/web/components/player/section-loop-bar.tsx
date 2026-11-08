'use client';

// The player's progress slot. One fixed height holds either bar, so opening the
// Loop a Part tool never moves the controls around it: the ordinary progress bar
// when the tool is closed, and a waveform when it is open. On the waveform a tap
// jumps and a drag marks the Section loop; the marks snap on release, and the
// repeating itself belongs to the controller.
//
// Position stays in this component (`pollWhileVisible`), and only what changes on
// screen updates: the playhead by direct style write, the bars only as the
// playhead crosses one, or as the marks move.

import {
  memo,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  SECTION_LOOP_END_MARGIN_SECONDS,
  SECTION_LOOP_MIN_SECONDS,
  snapLoopRegion,
  WAVEFORM_BAR_COUNT,
  type BufferLoopRegion,
} from '@liedmotif/shared';
import { MoveHorizontal, Repeat, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { PlayableTrack } from './playable-track';
import type { SectionLoopTool } from './playback-controller-api';
import { formatPlayerTime } from './player-time';
import { KEYBOARD_STEP_SECONDS, progressLabelRowClass, TrackProgress } from './track-progress';
import { pollWhileVisible } from './visible-poll';

/** The height both bars share, and the connecting frame that precedes them. */
export const progressSlotClass = 'h-[68px]';

const POLL_MS = 100;
/** How far a press must travel before it is a drag rather than a tap. */
const DRAG_THRESHOLD_PX = 8;
/** How close to a handle a press takes hold of it: a fingertip, not a pixel. */
const HANDLE_REACH_PX = 22;
/** Dragging the end plays this much of the run-up, to judge the seam by ear. */
const SEAM_PREVIEW_SECONDS = 2;
const ARROW_KEY_DIRECTION: Partial<Record<string, 1 | -1>> = {
  ArrowRight: 1,
  ArrowUp: 1,
  ArrowLeft: -1,
  ArrowDown: -1,
};

type ProgressProps = ComponentProps<typeof TrackProgress>;

type DragMode =
  | { kind: 'press'; x: number; anchor: number }
  | { kind: 'draw'; anchor: number }
  | { kind: 'start' | 'end'; x: number };

/** Where the marks sit with the pointer at `t`; a handle needs marks to move. */
function marksAt(
  mode: Exclude<DragMode, { kind: 'press' }>,
  marks: BufferLoopRegion | null,
  t: number,
): BufferLoopRegion | null {
  if (mode.kind === 'draw') {
    return { startSeconds: Math.min(mode.anchor, t), endSeconds: Math.max(mode.anchor, t) };
  }
  if (!marks) return null;
  return mode.kind === 'start'
    ? { ...marks, startSeconds: Math.min(t, marks.endSeconds - SECTION_LOOP_MIN_SECONDS) }
    : { ...marks, endSeconds: Math.max(t, marks.startSeconds + SECTION_LOOP_MIN_SECONDS) };
}

function clockWithTenths(seconds: number): string {
  const whole = Math.floor(seconds);
  const tenths = Math.floor((seconds - whole) * 10);
  return `${formatPlayerTime(whole)}.${tenths}`;
}

export function SectionLoopBar({
  tool,
  onSetLoop,
  onClearLoop,
  ...progress
}: ProgressProps & {
  tool: SectionLoopTool;
  onSetLoop: (region: BufferLoopRegion, fromSeconds: number) => void;
  onClearLoop: () => void;
}) {
  // Whether the drag hint has done its job; every fresh open teaches again.
  const [learned, setLearned] = useState(false);
  useEffect(() => {
    if (tool.phase === 'closed') setLearned(false);
  }, [tool.phase]);

  const { track } = progress;
  let bar = <TrackProgress {...progress} />;
  if (track && !progress.staged) {
    if (tool.phase === 'preparing') bar = <PreparingBar />;
    if (tool.phase === 'unavailable') {
      bar = (
        <>
          {bar}
          <p className="truncate text-center font-mono text-[10.5px] tracking-[0.08em] text-muted">
            This Track can’t loop: its full audio isn’t ready
          </p>
        </>
      );
    }
    if (tool.phase === 'ready') {
      bar = (
        <WaveformBar
          key={track.queueItemId}
          track={track}
          bars={tool.bars}
          duration={tool.durationSeconds}
          region={tool.region}
          progress={progress}
          showHint={!learned}
          onLearned={() => setLearned(true)}
          onSetLoop={onSetLoop}
          onClearLoop={onClearLoop}
        />
      );
    }
  }
  return (
    <div data-testid="progress-slot" className={progressSlotClass}>
      {bar}
    </div>
  );
}

function PreparingBar() {
  return (
    <div data-testid="section-loop-preparing">
      <div
        aria-hidden
        className="flex h-[48px] items-center gap-[2px] motion-safe:animate-progress-pulse"
      >
        {Array.from({ length: WAVEFORM_BAR_COUNT }, (_, index) => (
          <div key={index} className="h-[18%] min-w-0 flex-1 rounded-full bg-paper/25" />
        ))}
      </div>
      <div className={cn(progressLabelRowClass, 'mt-1 items-center justify-center')}>
        <span role="status">Preparing waveform…</span>
      </div>
    </div>
  );
}

function WaveformBar({
  track,
  bars,
  duration,
  region,
  progress,
  showHint,
  onLearned,
  onSetLoop,
  onClearLoop,
}: {
  track: PlayableTrack;
  bars: number[];
  duration: number;
  region: BufferLoopRegion | null;
  progress: ProgressProps;
  showHint: boolean;
  onLearned: () => void;
  onSetLoop: (region: BufferLoopRegion, fromSeconds: number) => void;
  onClearLoop: () => void;
}) {
  const { getPlaybackSample, seekTo } = progress;
  // The marks live in a ref as well as state: a fast flick delivers its events
  // faster than React renders between them, so the release can only trust what
  // has already been written.
  const [marks, setMarksState] = useState<BufferLoopRegion | null>(null);
  const marksRef = useRef<BufferLoopRegion | null>(null);
  const setMarks = (next: BufferLoopRegion | null) => {
    marksRef.current = next;
    setMarksState(next);
  };
  const [playedBars, setPlayedBars] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const drag = useRef<DragMode | null>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const barCount = bars.length;

  useEffect(
    () =>
      pollWhileVisible(POLL_MS, () => {
        const position = getPlaybackSample().positionSeconds ?? 0;
        const fraction = Math.min(position / duration, 1);
        if (playhead.current) playhead.current.style.left = `${fraction * 100}%`;
        setPlayedBars(Math.floor(fraction * barCount));
        setElapsed(Math.floor(position));
      }),
    [barCount, duration, getPlaybackSample],
  );

  const lastEnd = duration - SECTION_LOOP_END_MARGIN_SECONDS;
  const shown = marks ?? region;

  const timeAt = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1) * duration;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    onLearned();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = event.currentTarget.getBoundingClientRect();
    const pixelOf = (seconds: number) => rect.left + (seconds / duration) * rect.width;
    if (region) {
      const toStart = Math.abs(event.clientX - pixelOf(region.startSeconds));
      const toEnd = Math.abs(event.clientX - pixelOf(region.endSeconds));
      if (Math.min(toStart, toEnd) < HANDLE_REACH_PX) {
        drag.current = { kind: toStart < toEnd ? 'start' : 'end', x: event.clientX };
        setMarks(region);
        return;
      }
    }
    drag.current = { kind: 'press', x: event.clientX, anchor: timeAt(event) };
  };

  const followPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    let mode = drag.current;
    if (!mode) return;
    if (mode.kind === 'press') {
      if (Math.abs(event.clientX - mode.x) < DRAG_THRESHOLD_PX) return;
      mode = drag.current = { kind: 'draw', anchor: mode.anchor };
    }
    if (mode.kind !== 'draw' && Math.abs(event.clientX - mode.x) < 1) return;
    setMarks(marksAt(mode, marksRef.current, Math.min(timeAt(event), lastEnd)));
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    followPointer(event);
    const mode = drag.current;
    const marked = marksRef.current;
    drag.current = null;
    setMarks(null);
    if (!mode) return;
    if (mode.kind === 'press') {
      seekTo(timeAt(event));
      return;
    }
    // Held a handle without moving it: the loop already plays as marked.
    if (!marked || marked === region) return;
    const next = snapLoopRegion(marked, {
      durationSeconds: duration,
      analysis: track.blendAnalysis,
      targetBpm: track.targetBpm,
    });
    onSetLoop(
      next,
      mode.kind === 'end'
        ? Math.max(next.startSeconds, next.endSeconds - SEAM_PREVIEW_SECONDS)
        : next.startSeconds,
    );
  };

  // The progress bar's slider seeks by arrow key, so the waveform in its place must too.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const direction = ARROW_KEY_DIRECTION[event.key];
    if (!direction) return;
    event.preventDefault();
    const position = getPlaybackSample().positionSeconds ?? 0;
    seekTo(Math.max(0, position + direction * KEYBOARD_STEP_SECONDS));
  };

  return (
    <div data-testid="section-loop-waveform">
      <div
        role="slider"
        tabIndex={0}
        aria-label="Seek. Drag across the waveform to loop a part, tap to jump."
        aria-valuemin={0}
        aria-valuemax={Math.floor(duration)}
        aria-valuenow={elapsed}
        data-testid="section-loop-surface"
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={followPointer}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null;
          setMarks(null);
        }}
        className="relative flex h-[48px] cursor-ew-resize touch-pan-y select-none items-center gap-[2px] rounded-[10px]"
      >
        <WaveformBars
          bars={bars}
          playedBars={playedBars}
          loopStart={shown ? shown.startSeconds / duration : null}
          loopEnd={shown ? shown.endSeconds / duration : null}
        />
        {shown ? <LoopMarks region={shown} duration={duration} /> : null}
        <div ref={playhead} className="pointer-events-none absolute inset-y-0 w-[2px] bg-paper" />
        {showHint && !shown ? <DragHint /> : null}
      </div>
      <div className={cn(progressLabelRowClass, 'mt-1 items-center justify-between')}>
        <span>{formatPlayerTime(elapsed)}</span>
        {shown ? (
          <span data-testid="section-loop-label" className="flex items-center gap-1 text-signal">
            <Repeat className="h-3 w-3" aria-hidden />
            {clockWithTenths(shown.startSeconds)} – {clockWithTenths(shown.endSeconds)}
            {region && !marks ? (
              <button
                type="button"
                aria-label="Stop looping"
                onClick={onClearLoop}
                className="-my-3 grid h-9 w-9 place-items-center text-paper"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            ) : null}
          </span>
        ) : (
          <span className="truncate">
            {showHint ? 'Tap to jump' : 'Drag to loop a part · tap to jump'}
          </span>
        )}
        <span>{formatPlayerTime(duration)}</span>
      </div>
    </div>
  );
}

const WaveformBars = memo(function WaveformBars({
  bars,
  playedBars,
  loopStart,
  loopEnd,
}: {
  bars: number[];
  playedBars: number;
  /** Fractions of the Track; null without a loop. */
  loopStart: number | null;
  loopEnd: number | null;
}) {
  return (
    <>
      {bars.map((height, index) => {
        const at = (index + 0.5) / bars.length;
        const looped = loopStart != null && loopEnd != null && at >= loopStart && at <= loopEnd;
        const unlooped = index < playedBars ? 'bg-lamp' : 'bg-paper/25';
        return (
          <div
            key={index}
            className={cn('min-w-0 flex-1 rounded-full', looped ? 'bg-signal' : unlooped)}
            style={{ height: `${Math.max(8, height * 100)}%` }}
          />
        );
      })}
    </>
  );
});

function LoopMarks({ region, duration }: { region: BufferLoopRegion; duration: number }) {
  const percent = (seconds: number) => `${(seconds / duration) * 100}%`;
  return (
    <>
      <div
        className="pointer-events-none absolute inset-y-0 bg-signal/10"
        style={{
          left: percent(region.startSeconds),
          width: percent(region.endSeconds - region.startSeconds),
        }}
      />
      {[region.startSeconds, region.endSeconds].map((seconds) => (
        <div
          key={seconds}
          className="pointer-events-none absolute inset-y-0 w-[3px] -translate-x-1/2 rounded-full bg-signal"
          style={{ left: percent(seconds) }}
        >
          <span className="absolute left-1/2 top-1/2 h-6 w-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-signal bg-chassis" />
        </div>
      ))}
    </>
  );
}

/** A ghost of the gesture itself: a selection being dragged open across the bars. */
function DragHint() {
  return (
    <div
      data-testid="section-loop-hint"
      className="pointer-events-none absolute inset-0 overflow-hidden rounded-[10px]"
    >
      <div className="absolute inset-y-0 left-[32%] w-[36%] border-x-2 border-signal bg-signal/25 motion-safe:animate-section-loop-ghost">
        <span className="absolute right-[-11px] top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-signal shadow-[0_0_0_4px_var(--signal-dim)]" />
      </div>
      <div className="absolute inset-0 grid place-items-center">
        <span className="flex items-center gap-1.5 rounded-full border border-line-2 bg-panel px-3 py-1 text-[12px] font-semibold text-paper shadow-[0_2px_10px_rgba(0,0,0,0.18)]">
          <MoveHorizontal className="h-3.5 w-3.5 text-signal" aria-hidden />
          Drag across to loop a part
        </span>
      </div>
    </div>
  );
}
