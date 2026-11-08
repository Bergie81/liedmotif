'use client';

import { useEffect, useState } from 'react';
import { prefersReducedMotion } from '@/lib/prefers-reduced-motion';
import { SCRAMBLE_FRAME_MS, nextScrambleFrame, scrambleFrame } from './title-scramble';

/** The decode-sweep text driver: one sweep whenever `text` changes. Under
 * reduced motion the real text renders untouched. */
function useScrambleText(text: string): string {
  const [display, setDisplay] = useState(text);

  useEffect(() => {
    if (prefersReducedMotion()) {
      setDisplay(text);
      return;
    }
    let timer: number | undefined;
    let frame = 1;
    const run = () => {
      setDisplay(scrambleFrame(text, frame, Math.random));
      const next = nextScrambleFrame(frame);
      if (next == null) return;
      frame = next;
      timer = window.setTimeout(run, SCRAMBLE_FRAME_MS);
    };
    run();
    return () => window.clearTimeout(timer);
  }, [text]);

  return display;
}

/** A title that decodes into place. The churning glyphs are decorative — the
 * real text stays the accessible name, so screen readers never hear them. */
export function ScrambleText({ text }: { text: string }) {
  const display = useScrambleText(text);
  return (
    <>
      <span aria-hidden>{display}</span>
      <span className="sr-only">{text}</span>
    </>
  );
}
