'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { CoverArt } from './cover-art';
import { PlaceholderCoverMotion } from './placeholder-cover-motion';
import { coverArtSrc, isPlaceholderCover } from './player-presentation';

/** How long the arriving cover takes to fade in over the scene (matches
 *  `.pcm-reveal`); the scene unmounts once it is fully covered. */
const REVEAL_MS = 900;

/** The full-size player cover. The placeholder plays as a living scene; when a
 *  real cover replaces it, the new art is decoded first and then fades in over
 *  the still-moving scene, so the swap never shows a blank or half-loaded frame.
 *  Any other cover change swaps directly. */
export function HeroCoverArt({
  coverImageId,
  fallback,
}: {
  coverImageId: string | null;
  fallback: ReactNode;
}) {
  // The cover actually on screen. It trails `coverImageId` only while a real
  // cover replacing the placeholder is still decoding.
  const [shown, setShown] = useState(coverImageId);
  const [revealing, setRevealing] = useState(false);
  const shownIsPlaceholder = isPlaceholderCover(shown);

  useEffect(() => {
    if (coverImageId === shown) return;
    if (!shownIsPlaceholder || isPlaceholderCover(coverImageId)) {
      setShown(coverImageId);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.src = coverArtSrc(coverImageId);
    // A failed decode still swaps: CoverArt then shows its own fallback.
    void img
      .decode()
      .catch(() => {})
      .then(() => {
        if (cancelled) return;
        setShown(coverImageId);
        setRevealing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [coverImageId, shown, shownIsPlaceholder]);

  useEffect(() => {
    if (!revealing) return;
    const timer = setTimeout(() => setRevealing(false), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [revealing]);

  // Fixed child slots, so the scene keeps its element (and its beat) while the
  // arriving cover fades in on top of it.
  return (
    <>
      {shownIsPlaceholder || revealing ? <PlaceholderCoverMotion /> : null}
      {shownIsPlaceholder ? null : (
        <CoverArt
          coverImageId={shown}
          eager
          className={cn('relative h-full w-full object-cover', revealing && 'pcm-reveal')}
          fallback={fallback}
        />
      )}
    </>
  );
}
