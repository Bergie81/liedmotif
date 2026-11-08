// The Liedmotif mark's geometry, and the loader variants that animate it.
//
// One table drives both the static brand mark and every loading surface, so the
// logo and the loader can never drift apart.

/** One bar of the mark, in the square both the logo and the loader are drawn in. */
export interface MarkBar {
  x: number;
  y: number;
  width: number;
  height: number;
  rx: number;
  /**
   * The bar's brand colour, set as `color` so a bar filled with `currentColor`
   * and its glow are lit from one value.
   */
  toneClass: string;
  /**
   * Where the bar sits in the bounce on the loader's first frame — ignored by
   * the static mark. Negative, so the animation is already mid-cycle when a
   * loader appears; pairwise distinct, so the three bars never peak together
   * and the mark reads as an equalizer rather than a throbbing block.
   */
  delaySeconds: number;
}

export const MARK_VIEW_BOX_UNITS = 24;

export const MARK_VIEW_BOX = `0 0 ${MARK_VIEW_BOX_UNITS} ${MARK_VIEW_BOX_UNITS}`;

/**
 * The floor every bar stands on. The loader scales bars from
 * `transform-origin: center bottom`, so one shared floor is what keeps the
 * silhouette readable as the mark through the whole bounce.
 */
const BAR_FLOOR = 22.5;

/** The mark, bar by bar: short, tall, mid. */
const BARS = [
  { height: 11, toneClass: 'text-mark-1', delaySeconds: -0.82 },
  { height: 21, toneClass: 'text-mark-2', delaySeconds: -0.35 },
  { height: 15, toneClass: 'text-mark-3', delaySeconds: -0.62 },
];

/** The mark drawn at a given bar width, centred in the viewBox. */
function barsOfWidth(width: number, gap: number): readonly MarkBar[] {
  const left = (MARK_VIEW_BOX_UNITS - (width * 3 + gap * 2)) / 2;
  return BARS.map((bar, index) => ({
    ...bar,
    x: left + index * (width + gap),
    y: BAR_FLOOR - bar.height,
    width,
    rx: width / 2,
  }));
}

/** What the static brand mark draws, and what every loader above `xs` animates. */
export const MARK_BARS = barsOfWidth(4, 3);

/**
 * The mark redrawn for the smallest loaders. The logo's proportions turn into
 * sub-pixel slivers below ~18px, so the tiny glyph trades some of its gap for
 * bar width — same three heights, same floor, still the mark.
 */
const COMPACT_BARS = barsOfWidth(6, 2.5);

export const LOADER_SIZES = ['xs', 'sm', 'md', 'lg'] as const;

export type LoaderSize = (typeof LOADER_SIZES)[number];

export interface LoaderPresentation {
  /** Rendered edge length, in CSS pixels. */
  pixels: number;
  bars: readonly MarkBar[];
  /**
   * Bars carry a coloured halo. Off on the small variants, where a halo is
   * wider than the bar it lights and reads as blur rather than light.
   */
  glow: boolean;
  /** Diameter of the round surface the mark sits on, or null for a bare mark. */
  badgePixels: number | null;
}

const VARIANTS: Record<LoaderSize, LoaderPresentation> = {
  xs: { pixels: 14, bars: COMPACT_BARS, glow: false, badgePixels: null },
  sm: { pixels: 18, bars: MARK_BARS, glow: false, badgePixels: null },
  md: { pixels: 30, bars: MARK_BARS, glow: true, badgePixels: null },
  lg: { pixels: 48, bars: MARK_BARS, glow: true, badgePixels: 84 },
};

export function presentLoader(size: LoaderSize): LoaderPresentation {
  return VARIANTS[size];
}
