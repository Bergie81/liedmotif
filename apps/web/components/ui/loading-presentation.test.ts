import { describe, expect, it } from 'vitest';
import {
  LOADER_SIZES,
  MARK_BARS,
  MARK_VIEW_BOX_UNITS,
  presentLoader,
  type LoaderSize,
} from './loading-presentation';

const sizes: readonly LoaderSize[] = LOADER_SIZES;

describe('loader bars', () => {
  it('draws the mark: three bars, brand tones left to right', () => {
    for (const size of sizes) {
      const tones = presentLoader(size).bars.map((bar) => bar.toneClass);
      expect(tones).toEqual(['text-mark-1', 'text-mark-2', 'text-mark-3']);
    }
  });

  it('stands every bar on one baseline so the bars grow upward from a shared floor', () => {
    for (const size of sizes) {
      const floors = presentLoader(size).bars.map((bar) => bar.y + bar.height);
      expect(new Set(floors).size).toBe(1);
    }
  });

  it('keeps the mark recognisable: short, tall, mid at the same proportions everywhere', () => {
    const proportions = (size: LoaderSize) => {
      const heights = presentLoader(size).bars.map((bar) => bar.height);
      const tallest = Math.max(...heights);
      return heights.map((height) => Number((height / tallest).toFixed(4)));
    };
    for (const size of sizes) {
      expect(proportions(size)).toEqual(proportions('lg'));
    }
  });
});

describe('loader motion', () => {
  it('never lets two bars peak together — an equalizer, not a throb', () => {
    for (const size of sizes) {
      const delays = presentLoader(size).bars.map((bar) => bar.delaySeconds);
      expect(new Set(delays).size).toBe(delays.length);
    }
  });

  it('starts every bar mid-cycle so a loader that appears never visibly winds up', () => {
    for (const size of sizes) {
      for (const bar of presentLoader(size).bars) {
        expect(bar.delaySeconds).toBeLessThan(0);
      }
    }
  });
});

describe('loader variants', () => {
  it('never renders a bar too thin to read, however small the loader gets', () => {
    for (const size of sizes) {
      const { pixels, bars } = presentLoader(size);
      for (const bar of bars) {
        expect((bar.width / MARK_VIEW_BOX_UNITS) * pixels).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('grows from a button glyph to a full screen', () => {
    const pixels = sizes.map((size) => presentLoader(size).pixels);
    expect(pixels).toEqual([...pixels].sort((a, b) => a - b));
    expect(new Set(pixels).size).toBe(sizes.length);
  });

  it('lights the bars only where the loader is large enough to carry a glow', () => {
    expect(sizes.filter((size) => presentLoader(size).glow)).toEqual(['md', 'lg']);
  });

  it('mounts the mark on a badge only on the full-screen loader', () => {
    expect(sizes.filter((size) => presentLoader(size).badgePixels !== null)).toEqual(['lg']);
  });

  it('sizes the badge to frame the mark rather than crop it', () => {
    const { pixels, badgePixels } = presentLoader('lg');
    expect(badgePixels).toBeGreaterThan(pixels);
  });
});

describe('the static mark', () => {
  const widths = (bars: readonly { width: number }[]) => bars.map((bar) => bar.width);

  it('is drawn at the logo proportions the full-size loader animates', () => {
    expect(widths(MARK_BARS)).toEqual(widths(presentLoader('lg').bars));
  });

  it('is not the compact glyph, which trades proportion for legibility', () => {
    expect(widths(MARK_BARS)).not.toEqual(widths(presentLoader('xs').bars));
  });
});
