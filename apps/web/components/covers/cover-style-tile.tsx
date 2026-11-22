'use client';

import Image from 'next/image';
import { PenLine, Shuffle, WandSparkles } from 'lucide-react';
import { COVER_STYLE_PRESETS } from '@liedmotif/shared';
import type { CoverStyleChoice } from '@liedmotif/shared';
import { cn } from '@/lib/cn';
import { coverStyleExampleSrc } from '@/lib/covers/cover-styles';

// `row` is the Settings picker's tile, `option` the smaller one a dropdown
// option carries. `cell` is the width a mosaic cell's square example renders
// at: the cell is a third of the tile wide and half of it tall.
const SIZES = {
  row: {
    tile: 'h-[72px] w-[72px] rounded-[10px]',
    edge: '72px',
    cell: '36px',
    disc: 'h-[30px] w-[30px]',
    glyph: 'h-4 w-4',
    customGlyph: 'h-6 w-6',
  },
  option: {
    tile: 'h-11 w-11 rounded-[8px]',
    edge: '44px',
    cell: '22px',
    disc: 'h-5 w-5',
    glyph: 'h-3 w-3',
    customGlyph: 'h-4 w-4',
  },
} as const;

/**
 * A cover style choice's example tile, pure decoration (empty alt) so a screen
 * reader hears only the style's name and explanation. Auto and Random can land
 * on any preset, so both show all six examples, told apart by the glyph on top;
 * Custom has no example because its look is whatever the user writes.
 */
export function CoverStyleTile({
  choice,
  size = 'row',
}: {
  choice: CoverStyleChoice;
  size?: keyof typeof SIZES;
}) {
  const s = SIZES[size];
  const tileClass = cn('relative block shrink-0 overflow-hidden', s.tile);
  if (choice === 'custom') {
    return (
      <span className={cn(tileClass, 'grid place-items-center border border-line-2 bg-panel')}>
        <PenLine className={cn(s.customGlyph, 'text-muted')} aria-hidden />
      </span>
    );
  }
  if (choice === 'auto' || choice === 'random') {
    const Glyph = choice === 'auto' ? WandSparkles : Shuffle;
    return (
      <span className={cn(tileClass, 'bg-panel-2')}>
        <span className="grid h-full w-full grid-cols-3 grid-rows-2">
          {COVER_STYLE_PRESETS.map((preset) => (
            <span key={preset} className="relative">
              <Image
                src={coverStyleExampleSrc(preset)}
                alt=""
                fill
                sizes={s.cell}
                className="object-cover"
              />
            </span>
          ))}
        </span>
        <span
          className={cn(
            'absolute left-1/2 top-1/2 grid -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-night/75 text-paper backdrop-blur-[4px]',
            s.disc,
          )}
        >
          <Glyph className={s.glyph} aria-hidden />
        </span>
      </span>
    );
  }
  return (
    <span className={cn(tileClass, 'bg-panel-2')}>
      <Image
        src={coverStyleExampleSrc(choice)}
        alt=""
        fill
        sizes={s.edge}
        className="object-cover"
      />
    </span>
  );
}
