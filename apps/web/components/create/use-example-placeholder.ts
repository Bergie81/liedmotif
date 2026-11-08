'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { readBrowserPreference, writeBrowserPreference } from '@/lib/browser-preferences';
import { prefersReducedMotion } from '@/lib/prefers-reduced-motion';
import {
  PROMPT_EXAMPLES,
  TYPE_FRAME_MS,
  nextTypedFrame,
  pickExampleIndex,
  typedFrame,
} from './prompt-examples';

/** Remembers the last-shown example so a second visit does not repeat it. */
const LAST_EXAMPLE_KEY = 'liedmotif-describe-example';

const TYPING_CARET = '▌';

/** One example prompt per mount, typed into the Describe field's placeholder
 * over a constant ~2s regardless of length. The pick happens client-side in
 * an effect (never during render) so the server-rendered markup stays
 * deterministic. `settle` jumps to the complete example and stops the motion;
 * the hook settles itself as soon as the field holds any value, so a cleared
 * field rests on the same example, complete and static. Under reduced motion
 * the example renders immediately with no frames and no caret. */
export function useExamplePlaceholder(value: string): {
  placeholder: string;
  example: string;
  settle: () => void;
} {
  const [placeholder, setPlaceholder] = useState('');
  /** The complete picked text, exposed so the field can be sized to the full
   * example before the first frame is typed. */
  const [example, setExample] = useState('');
  /** Null until the one pick of this mount has happened — the pick must not
   * repeat even if the effect re-runs (StrictMode remount), or
   * consecutive-visit exclusion would burn through stored indexes. */
  const pickedRef = useRef<string | null>(null);
  const settledRef = useRef(false);

  const settle = useCallback(() => {
    settledRef.current = true;
    if (pickedRef.current) setPlaceholder(pickedRef.current);
  }, []);

  useEffect(() => {
    if (pickedRef.current == null) {
      const stored = Number.parseInt(readBrowserPreference(LAST_EXAMPLE_KEY) ?? '', 10);
      const index = pickExampleIndex(
        PROMPT_EXAMPLES,
        Number.isNaN(stored) ? null : stored,
        Math.random,
      );
      writeBrowserPreference(LAST_EXAMPLE_KEY, String(index));
      pickedRef.current = PROMPT_EXAMPLES[index] ?? '';
    }
    const picked = pickedRef.current;
    setExample(picked);

    if (settledRef.current || prefersReducedMotion()) {
      setPlaceholder(picked);
      return;
    }

    let timer: number | undefined;
    let frame = 0;
    const run = () => {
      if (settledRef.current) return;
      const next = nextTypedFrame(frame);
      setPlaceholder(next == null ? picked : typedFrame(picked, frame) + TYPING_CARET);
      if (next == null) return;
      frame = next;
      timer = window.setTimeout(run, TYPE_FRAME_MS);
    };
    run();
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (value !== '') settle();
  }, [value, settle]);

  return { placeholder, example, settle };
}
