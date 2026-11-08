// The physics behind the last onboarding step's burst: falling, tumbling paper.
//
// Every value is derived from the piece's index rather than `Math.random()`, so the
// burst looks scattered while staying reproducible — the same width always yields the
// same fall, which is what makes the motion assertable.
//
// Three air effects make the fall read as paper rather than pixels: drag caps each
// piece at its own terminal velocity, side-to-side sway with glide lift makes pieces
// flutter instead of dropping in straight lines, and a tumble about the long axis
// periodically thins each piece toward its edge.

export interface ConfettiPiece {
  x: number;
  y: number;
  /** Launch scatter only; air resistance bleeds it off within the first second. */
  vx: number;
  vy: number;
  /** Where drag stops accelerating this piece. Varies per piece, so the burst
   * separates vertically as it falls the way mixed paper sizes do. */
  terminalVy: number;
  /** Half-width/height are what the canvas draws around the piece's centre. */
  w: number;
  h: number;
  rot: number;
  vr: number;
  /** The side-to-side rock. `cos(swayPhase)` is the current lateral glide. */
  swayPhase: number;
  swayRate: number;
  swayAmp: number;
  /** The flip about the piece's long axis; `cos(tumblePhase)` is its apparent width. */
  tumblePhase: number;
  tumbleRate: number;
  /** Which shade of the highlight colour the canvas draws this piece in. */
  shadeIndex: number;
}

export const CONFETTI_PIECE_COUNT = 140;
export const CONFETTI_SHADE_COUNT = 5;
/** Per-frame downward acceleration, tuned for a ~60fps canvas loop. */
const GRAVITY = 0.045;
/** How much of each frame's leftover launch scatter survives to the next. */
const HORIZONTAL_DRAG = 0.98;
/** How much a piece's descent slows at the peak of its sideways glide — the pause
 * that makes paper look like it is riding the air rather than sinking through it. */
const GLIDE_LIFT = 0.35;
/** A tumbling piece never quite vanishes: paper seen edge-on still has a visible rim. */
const EDGE_ON_MIN_SCALE = 0.12;
/** How far below the bottom edge a piece must be before it stops being drawn. */
const OFF_SCREEN_MARGIN = 40;
/** How far above the top edge the burst is stacked. Deep enough that the last piece
 * lands seconds after the first, which is what reads as rain rather than a curtain. */
const STAGGER_DEPTH = 500;
/** Any fixed seed does; this one just has to stay put so the burst stays assertable. */
const SEED = 0x9e3779b9;

/** Mulberry32 — a seeded generator, because the scatter has to look random and
 * behave the same every run. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh burst: every piece gets its own column, height, speed, sway and tumble,
 * so none of them travel as a group. */
export function createConfettiPieces(viewportWidth: number): ConfettiPiece[] {
  const random = seededRandom(SEED);
  return Array.from({ length: CONFETTI_PIECE_COUNT }, () => ({
    x: random() * viewportWidth,
    y: -20 - random() * STAGGER_DEPTH,
    vx: (random() - 0.5) * 2.4,
    // Launched below terminal velocity so drag only ever closes the gap upward —
    // pieces ease into their fall instead of overshooting and braking.
    vy: 1 + random() * 1.5,
    terminalVy: 3 + random() * 1.6,
    w: 5 + random() * 6,
    h: 8 + random() * 7,
    rot: random() * Math.PI * 2,
    vr: (random() - 0.5) * 0.3,
    swayPhase: random() * Math.PI * 2,
    swayRate: 0.06 + random() * 0.06,
    swayAmp: 0.8 + random() * 1.2,
    tumblePhase: random() * Math.PI * 2,
    tumbleRate: 0.05 + random() * 0.13,
    shadeIndex: Math.floor(random() * CONFETTI_SHADE_COUNT),
  }));
}

/** The next frame of the fall. Pure: the caller's frame stays valid. */
export function advanceConfetti(pieces: ConfettiPiece[]): ConfettiPiece[] {
  return pieces.map((piece) => {
    const glide = Math.cos(piece.swayPhase);
    return {
      ...piece,
      x: piece.x + piece.vx + glide * piece.swayAmp,
      y: piece.y + piece.vy * (1 - GLIDE_LIFT * Math.abs(glide)),
      vx: piece.vx * HORIZONTAL_DRAG,
      // Gravity scaled by the distance to terminal velocity is drag in disguise:
      // the increment hits zero exactly when the piece reaches its cap.
      vy: piece.vy + GRAVITY * (1 - piece.vy / piece.terminalVy),
      rot: piece.rot + piece.vr,
      swayPhase: piece.swayPhase + piece.swayRate,
      tumblePhase: piece.tumblePhase + piece.tumbleRate,
    };
  });
}

/** How wide the canvas should draw a piece right now: the tumble about the long axis
 * foreshortens the width down to a sliver and back. */
export function drawnWidthScale(piece: ConfettiPiece): number {
  return Math.max(EDGE_ON_MIN_SCALE, Math.abs(Math.cos(piece.tumblePhase)));
}

/** True once nothing is left to draw, which is when the loop stops. */
export function confettiSettled(pieces: ConfettiPiece[], viewportHeight: number): boolean {
  return pieces.every((piece) => piece.y >= viewportHeight + OFF_SCREEN_MARGIN);
}
