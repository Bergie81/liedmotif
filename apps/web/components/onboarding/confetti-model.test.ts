import { describe, expect, it } from 'vitest';
import {
  advanceConfetti,
  confettiSettled,
  createConfettiPieces,
  drawnWidthScale,
  type ConfettiPiece,
} from './confetti-model';

const VIEWPORT_WIDTH = 400;
const VIEWPORT_HEIGHT = 800;

function advanceFrames(pieces: ConfettiPiece[], frames: number): ConfettiPiece[] {
  let current = pieces;
  for (let i = 0; i < frames; i++) current = advanceConfetti(current);
  return current;
}

describe('createConfettiPieces', () => {
  it('is deterministic for a given viewport width', () => {
    expect(createConfettiPieces(VIEWPORT_WIDTH)).toEqual(createConfettiPieces(VIEWPORT_WIDTH));
  });

  it('scatters pieces across the viewport width and stacks them above the top edge', () => {
    const pieces = createConfettiPieces(VIEWPORT_WIDTH);
    expect(pieces.every((p) => p.x >= 0 && p.x <= VIEWPORT_WIDTH)).toBe(true);
    expect(pieces.every((p) => p.y < 0)).toBe(true);
  });
});

describe('advanceConfetti', () => {
  it('never accelerates a piece past its terminal velocity', () => {
    let pieces = createConfettiPieces(VIEWPORT_WIDTH);
    for (let i = 0; i < 600; i++) {
      pieces = advanceConfetti(pieces);
      for (const piece of pieces) {
        expect(piece.vy).toBeLessThanOrEqual(piece.terminalVy + 1e-9);
      }
    }
  });

  it('keeps every piece descending on every frame', () => {
    let pieces = createConfettiPieces(VIEWPORT_WIDTH);
    for (let i = 0; i < 300; i++) {
      const next = advanceConfetti(pieces);
      pieces.forEach((piece, j) => {
        expect(next[j]!.y).toBeGreaterThan(piece.y);
      });
      pieces = next;
    }
  });

  it('sways pieces side to side rather than dropping them in straight lines', () => {
    const start = createConfettiPieces(VIEWPORT_WIDTH);
    let pieces = start;
    const leftmost = start.map((p) => p.x);
    const rightmost = start.map((p) => p.x);
    for (let i = 0; i < 300; i++) {
      pieces = advanceConfetti(pieces);
      pieces.forEach((p, j) => {
        leftmost[j] = Math.min(leftmost[j]!, p.x);
        rightmost[j] = Math.max(rightmost[j]!, p.x);
      });
    }
    // Every piece wanders off its column, but flutter drift stays local — it never
    // reads as wind blowing the burst sideways.
    expect(start.every((p, j) => rightmost[j]! - leftmost[j]! > 2)).toBe(true);
    expect(start.every((p, j) => rightmost[j]! - leftmost[j]! < 200)).toBe(true);
  });

  it('does not mutate the frame it was given', () => {
    const pieces = createConfettiPieces(VIEWPORT_WIDTH);
    const snapshot = structuredClone(pieces);
    advanceConfetti(pieces);
    expect(pieces).toEqual(snapshot);
  });
});

describe('drawnWidthScale', () => {
  it('thins a piece toward its paper edge without ever vanishing', () => {
    let pieces = createConfettiPieces(VIEWPORT_WIDTH);
    let min = 1;
    let max = 0;
    for (let i = 0; i < 600; i++) {
      pieces = advanceConfetti(pieces);
      for (const piece of pieces) {
        const scale = drawnWidthScale(piece);
        min = Math.min(min, scale);
        max = Math.max(max, scale);
      }
    }
    expect(min).toBeGreaterThan(0);
    expect(min).toBeLessThan(0.3);
    expect(max).toBeGreaterThan(0.95);
    expect(max).toBeLessThanOrEqual(1);
  });
});

describe('confettiSettled', () => {
  it('is false while pieces are still falling and true once all are past the bottom', () => {
    let pieces = createConfettiPieces(VIEWPORT_WIDTH);
    expect(confettiSettled(pieces, VIEWPORT_HEIGHT)).toBe(false);
    pieces = advanceFrames(pieces, 2000);
    expect(confettiSettled(pieces, VIEWPORT_HEIGHT)).toBe(true);
  });
});
