// Cuts the bounded display window around the first query hit in a matched
// field's text — the server-side half of the match-context line, so a long
// prompt or a whole lyric body never ships in full. Pure string work: no SQL,
// and no highlighting (the client owns that).

/** Total snippet budget, in UTF-16 units. */
const SNIPPET_WINDOW = 96;
const ELLIPSIS = '…';

/**
 * A one-line window into `text` around its first case-insensitive occurrence
 * of `query`, with ellipses marking trimmed ends. Whitespace runs collapse to
 * single spaces so multi-line bodies read as one line. When the query cannot
 * be located (it matched under SQL's collation but not JS's lowercasing, or a
 * genre tag with punctuation ignored), the head of the text is shown instead.
 */
export function cutSnippet(text: string, query: string, window: number = SNIPPET_WINDOW): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= window) return flat;

  const needle = query.replace(/\s+/g, ' ').trim().toLowerCase();
  const hit = needle ? flat.toLowerCase().indexOf(needle) : -1;
  const lead = Math.floor(window / 4);
  const from = hit < 0 ? 0 : Math.max(0, Math.min(hit - lead, flat.length - window));
  const start = snapToCodePoint(flat, from);
  const end = snapToCodePoint(flat, Math.min(flat.length, start + window));

  const head = start > 0 ? ELLIPSIS : '';
  const tail = end < flat.length ? ELLIPSIS : '';
  return head + flat.slice(start, end).trim() + tail;
}

/** Steps a cut index off a low surrogate so no pair is ever split. */
function snapToCodePoint(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}
