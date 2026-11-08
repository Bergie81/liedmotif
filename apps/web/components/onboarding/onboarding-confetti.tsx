// The burst that fires once when setup is finished — the single celebration in the
// product, so it stays confined to this one screen.
//
// Decorative only: it sits behind `aria-hidden`, ignores pointer events, and never
// runs under reduced motion.

'use client';

import { useEffect, useRef } from 'react';
import { prefersReducedMotion } from '@/lib/prefers-reduced-motion';
import {
  advanceConfetti,
  confettiSettled,
  createConfettiPieces,
  drawnWidthScale,
  type ConfettiPiece,
} from './confetti-model';

/** Opacity per shade index: one highlight colour, read back from the live theme, at
 * five depths — so the burst carries the brand rather than a party palette. */
const SHADE_ALPHAS = [1, 0.86, 0.72, 0.58, 0.44];

/** The highlight colour as the current theme resolves it, so light mode gets its own. */
function highlightColor(canvas: HTMLCanvasElement): string {
  return getComputedStyle(canvas).getPropertyValue('--lamp').trim() || '#ffb25c';
}

function draw(
  ctx: CanvasRenderingContext2D,
  pieces: ConfettiPiece[],
  size: { width: number; height: number },
  color: string,
) {
  ctx.clearRect(0, 0, size.width, size.height);
  ctx.fillStyle = color;
  for (const piece of pieces) {
    ctx.save();
    ctx.globalAlpha = SHADE_ALPHAS[piece.shadeIndex] ?? 1;
    ctx.translate(piece.x, piece.y);
    ctx.rotate(piece.rot);
    const w = piece.w * drawnWidthScale(piece);
    ctx.fillRect(-w / 2, -piece.h / 2, w, piece.h);
    ctx.restore();
  }
}

export function OnboardingConfetti() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || prefersReducedMotion()) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // The burst is sized once, at the moment it fires: a mid-fall resize would have
    // to re-seed the pieces, and the whole thing is over in a couple of seconds.
    const size = { width: window.innerWidth, height: window.innerHeight };
    const ratio = window.devicePixelRatio || 1;
    canvas.width = size.width * ratio;
    canvas.height = size.height * ratio;
    ctx.scale(ratio, ratio);

    const color = highlightColor(canvas);
    let pieces = createConfettiPieces(size.width);
    let frame = requestAnimationFrame(function step() {
      pieces = advanceConfetti(pieces);
      draw(ctx, pieces, size, color);
      if (!confettiSettled(pieces, size.height)) frame = requestAnimationFrame(step);
      else ctx.clearRect(0, 0, size.width, size.height);
    });

    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-40 h-full w-full"
    />
  );
}
