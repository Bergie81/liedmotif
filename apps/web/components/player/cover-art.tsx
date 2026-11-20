'use client';

import { useState, type ReactNode } from 'react';
import { Disc3 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useTrackMedia } from './track-media';

/** Cover art that always shows an image: the known cover, else the built-in
 * placeholder art. The inline `fallback` appears only if the bytes themselves
 * fail to load (placeholder not yet ingested, or an unauthenticated tab), or
 * where there is no image at all (a Track offline without a stored cover). */
export function CoverArt({
  coverImageId,
  className,
  fallback,
  thumb = false,
  eager = false,
}: {
  coverImageId: string | null;
  className?: string;
  fallback: ReactNode;
  /** Small tiles (list rows, sheet headers) load the downscaled rendition. */
  thumb?: boolean;
  /** Hero surfaces (the sleeve faces) load immediately; everything else defers
   *  until the image nears the viewport, so opening a sheet doesn't fire every
   *  row's request at once. */
  eager?: boolean;
}) {
  const src = useTrackMedia().coverSrc(coverImageId, thumb ? 'thumb' : 'full');
  // Keyed by src so a later cover id gets a fresh load attempt.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (src === null || failedSrc === src) return <>{fallback}</>;
  return (
    <img
      src={src}
      alt=""
      className={className}
      draggable={false}
      loading={eager ? undefined : 'lazy'}
      decoding="async"
      onError={() => setFailedSrc(src)}
    />
  );
}

/** What a cover filling its frame shows when no image can: the players and Reroll
 * Cover Art. List rows and sheet thumbnails want quieter fallbacks of their own,
 * which is why `CoverArt` asks every caller to name one. */
export function CoverFallback({ iconClassName = 'h-20 w-20' }: { iconClassName?: string }) {
  return (
    <div className="grid h-full w-full place-items-center [background:radial-gradient(80%_70%_at_50%_40%,var(--panel-2),var(--chassis))]">
      <Disc3 className={cn('text-lamp/70', iconClassName)} aria-hidden />
    </div>
  );
}

/** Cover art at the size a sheet header carries it: square, hairline-inset,
 * beside the title rather than above it. */
export function CoverThumb({ coverImageId }: { coverImageId: string | null }) {
  return (
    <span className="h-11 w-11 flex-none overflow-hidden rounded-[2px] shadow-[inset_0_0_0_1px_var(--line)]">
      <CoverArt
        coverImageId={coverImageId}
        thumb
        className="h-full w-full object-cover"
        fallback={<span className="block h-full w-full bg-panel-2" />}
      />
    </span>
  );
}
