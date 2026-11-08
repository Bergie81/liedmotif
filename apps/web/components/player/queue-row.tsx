'use client';

// One row of a Playlist's playing order: art, a title block, one
// trailing readout, and a tap that jumps to the Track.

import type { ReactNode } from 'react';
import { Disc3, Play } from 'lucide-react';
import { SheetClose } from '@/components/ui/sheet';
import { CoverArt } from './cover-art';

/** Art, the title block that absorbs the slack, one readout. */
const rowClass =
  'grid w-full grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-3 rounded-[10px] py-2 text-left';

/** What stands where the rows would be when the overlay has none. */
export const queueEmptyNoteClass =
  'mt-6 rounded-card-sm border border-dashed border-line-2 px-4 py-8 text-center text-[13.5px] text-muted';

export function QueueRow({
  title,
  coverImageId,
  playing,
  onPlay,
  children,
}: {
  /** The Track's display name — what the row's action announces. */
  title: string;
  coverImageId: string | null;
  /** The row the transport is on: badged art, and its tap reads as Restart. */
  playing: boolean;
  /** Absent while there is nothing to play (a Track still being generated, or
   *  one whose audio never arrived): the row states itself and stays put. */
  onPlay?: () => void;
  /** The middle and trailing cells — what this overlay has to say about a row. */
  children: ReactNode;
}) {
  const cells = (
    <>
      <span className="relative grid h-12 w-12 place-items-center overflow-hidden rounded-[10px] bg-panel-2">
        <CoverArt
          coverImageId={coverImageId}
          thumb
          className="h-full w-full object-cover"
          fallback={<Disc3 className="h-5 w-5 text-dim" aria-hidden />}
        />
        {playing ? (
          <span className="absolute inset-0 grid place-items-center bg-black/40 text-lamp">
            <Play className="h-4 w-4 fill-current" aria-hidden />
          </span>
        ) : null}
      </span>
      {children}
    </>
  );
  return (
    <li className="border-b border-line last:border-b-0">
      {onPlay ? (
        // Jumping IS the answer, so the overlay closes behind the tap.
        <SheetClose asChild>
          <button
            type="button"
            aria-label={`${playing ? 'Restart' : 'Play'} ${title}`}
            onClick={onPlay}
            className={`${rowClass} hover:bg-[var(--control-bg-hover)] active:scale-[0.995]`}
          >
            {cells}
          </button>
        </SheetClose>
      ) : (
        <div className={rowClass}>{cells}</div>
      )}
    </li>
  );
}
