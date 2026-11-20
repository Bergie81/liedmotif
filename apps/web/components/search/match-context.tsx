// The one line on every result row naming the single field that won it its
// place, with the typed words highlighted inside the server-cut snippet.
// Highlighting happens HERE and only here: the client locates the query in
// the snippet case-insensitively — no index arithmetic crosses the wire.

import { escapeRegExp, type SearchMatchContext, type SearchMatchField } from '@liedmotif/shared';

/** Total over the field union: a new field cannot ship without a label. */
export const MATCH_FIELD_LABELS: Record<SearchMatchField, string> = {
  name: 'Name',
  tags: 'Tags',
  prompt: 'Prompt',
  session: 'Session',
  tracks: 'Tracks',
  lyrics: 'Lyrics',
  owner: 'Shared By',
};

export interface SnippetPart {
  text: string;
  hit: boolean;
}

/**
 * The snippet split around every case-insensitive, literal occurrence of the
 * query. A snippet without the query (SQL matched under a collation JS does
 * not reproduce, or a genre tag with punctuation ignored) renders as one
 * unhighlighted part rather than throwing.
 */
export function highlightSnippet(snippet: string, query: string): SnippetPart[] {
  const needle = query.trim();
  if (!needle) return [{ text: snippet, hit: false }];
  const literal = new RegExp(escapeRegExp(needle), 'gi');
  const parts: SnippetPart[] = [];
  let last = 0;
  for (const match of snippet.matchAll(literal)) {
    if (match.index > last) parts.push({ text: snippet.slice(last, match.index), hit: false });
    parts.push({ text: match[0], hit: true });
    last = match.index + match[0].length;
  }
  if (last < snippet.length || parts.length === 0) {
    parts.push({ text: snippet.slice(last), hit: false });
  }
  return parts;
}

export function MatchContextLine({
  context,
  query,
}: {
  context: SearchMatchContext;
  query: string;
}) {
  return (
    <span className="mt-[3px] block truncate font-mono text-[10.5px] tracking-[0.04em] text-dim">
      <span className="uppercase">{MATCH_FIELD_LABELS[context.field]}</span>
      {' · '}
      {highlightSnippet(context.snippet, query).map((part, index) =>
        part.hit ? (
          <mark key={index} className="bg-transparent font-semibold text-lamp">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}
