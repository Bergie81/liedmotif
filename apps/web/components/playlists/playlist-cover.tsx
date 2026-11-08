'use client';

// A Playlist's artwork: the custom cover when one is set, otherwise the derived
// 2x2 mosaic of up to 4 distinct member covers (always the fallback — a
// Playlist never renders coverless). Distinctness and order come from the
// server (`mosaicCoverImageIds`); a Session Cover is one shared image, a
// Playlist visibly changes art per member.

import Image from 'next/image';
import { ListMusic } from 'lucide-react';
import { cn } from '@/lib/cn';
import { coverArtSrc } from '@/components/player/player-presentation';

export function PlaylistCover({
  coverImageId,
  mosaicCoverImageIds,
  className,
  thumb = false,
}: {
  coverImageId: string | null;
  mosaicCoverImageIds: string[];
  className?: string;
  /** Thumbnails are for tiles rendered at or below the rendition edge (160 px)
   *  — list rows, search rows, headers — never for full-card artwork, which
   *  hi-DPI screens would visibly upscale. Mosaic tiles always load the
   *  downscaled rendition regardless: each fills at most a quarter of the
   *  container, so they never exceed the rendition edge. */
  thumb?: boolean;
}) {
  const src = (id: string) => coverArtSrc(id, thumb ? 'thumb' : 'full');
  if (coverImageId) {
    return (
      <div className={cn('relative overflow-hidden bg-panel-2', className)}>
        <Image src={src(coverImageId)} alt="" fill className="object-cover" />
      </div>
    );
  }
  const tiles = mosaicCoverImageIds.slice(0, 4);
  if (tiles.length === 0) {
    return (
      <div className={cn('grid place-items-center bg-panel-2', className)}>
        <ListMusic className="h-1/3 w-1/3 text-muted" aria-hidden />
      </div>
    );
  }
  if (tiles.length === 1) {
    return (
      <div className={cn('relative overflow-hidden bg-panel-2', className)}>
        <Image src={src(tiles[0]!)} alt="" fill className="object-cover" />
      </div>
    );
  }
  // 2-3 covers pad by repeating from the front so the grid stays full.
  const grid = [...tiles, ...tiles, ...tiles, ...tiles].slice(0, 4);
  return (
    <div className={cn('grid grid-cols-2 grid-rows-2 overflow-hidden bg-panel-2', className)}>
      {grid.map((id, index) => (
        <div key={`${id}-${index}`} className="relative">
          <Image src={coverArtSrc(id, 'thumb')} alt="" fill className="object-cover" />
        </div>
      ))}
    </div>
  );
}
