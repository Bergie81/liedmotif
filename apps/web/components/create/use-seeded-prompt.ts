'use client';

import { useState } from 'react';

/**
 * The Describe field's draft, seeded ONCE at mount (the search hand-off's
 * client half — the param helpers stay in the server-safe `intent-prefill.ts`).
 * A later change to the initial value never overwrites what the user has
 * typed — the prefill is a starting point, not a binding.
 */
export function useSeededPrompt(
  initialPrompt: string | undefined,
): [string, (value: string) => void] {
  return useState(initialPrompt ?? '');
}
