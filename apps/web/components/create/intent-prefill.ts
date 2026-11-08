// The search → Home hand-off (the empty state hands the query to the
// create card). /search holds ZERO creation logic: it only builds a link, and
// Home seeds the Describe field once — the text-LLM requirement, headroom
// gate, voice blocking and all defaults stay resolved in one place, here.
// Server-safe on purpose: the Home page (a server component) reads the
// parameter, so no React import may live here (the seeding hook is
// `use-seeded-prompt.ts`).

import { MAX_USER_PROMPT_LENGTH } from '@liedmotif/shared';

export const INTENT_PARAM = 'intent';

/** The Home link that prefills the create card with the searched words. */
export function homeIntentHref(query: string): string {
  return `/?${INTENT_PARAM}=${encodeURIComponent(query)}`;
}

/** The prefill from the page's `searchParams` value: trimmed and bounded, or null. */
export function intentFromParam(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim().slice(0, MAX_USER_PROMPT_LENGTH);
  return trimmed || null;
}
