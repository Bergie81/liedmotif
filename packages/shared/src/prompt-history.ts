// The two definitions of "the prompt text": how a Session's prompt history
// grows, and the bound Track Data shows it under. Shared by the Change Vibe
// write path, the per-request stamp, and both Track Data read boundaries, so
// what a Track says it came from cannot drift between them.

import { MAX_USER_PROMPT_LENGTH } from './contracts/endpoints';

/** Longest prompt text Track Data ever shows or embeds (`TXXX:Prompt`). */
export const MAX_TRACK_DATA_PROMPT_LENGTH = 1000;

/** What an empty line between two prompts is, on the wire and on screen. */
const SEGMENT_SEPARATOR = '\n\n';

/**
 * Bound to `maxLength` characters, an over-long value ending in an ellipsis
 * that counts toward the bound. Pure, so the same text always yields the same
 * result — what lets the ID3 tag-state marker hash it. The cut never splits a
 * surrogate pair (half an emoji is not text), which can cost one more character.
 */
function truncatePrompt(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const cut = maxLength - 1;
  const lastKept = text.charCodeAt(cut - 1);
  const splitsPair = lastKept >= 0xd800 && lastKept <= 0xdbff;
  return `${text.slice(0, splitsPair ? cut - 1 : cut)}…`;
}

/**
 * The Session's stored prompt after a Change Vibe carrying text: the history so
 * far, extended by the new text with an empty line between them.
 *
 * The append is SKIPPED when the incoming text is already the whole history or
 * its last segment — the picks-only fine-tune resends the stored prompt verbatim
 * as its intent, and a repeated identical tweak would otherwise double itself.
 * The result is bounded by the API edge's prompt limit, truncating the tail so
 * the origin always survives (and so the picks-only resend stays schema-valid).
 */
export function extendPromptHistory(stored: string | null, incoming: string): string {
  const history = stored?.trim() ?? '';
  const addition = incoming.trim();
  if (!addition) return history;
  if (!history) return truncatePrompt(addition, MAX_USER_PROMPT_LENGTH);
  const lastSegment = history.split(SEGMENT_SEPARATOR).at(-1)!.trim();
  if (addition === history || addition === lastSegment) return history;
  return truncatePrompt(`${history}${SEGMENT_SEPARATOR}${addition}`, MAX_USER_PROMPT_LENGTH);
}

/** A prompt history bounded for Track Data; null stays null (nothing to show). */
export function truncateTrackDataPrompt(text: string | null): string | null {
  return text == null ? null : truncatePrompt(text, MAX_TRACK_DATA_PROMPT_LENGTH);
}
