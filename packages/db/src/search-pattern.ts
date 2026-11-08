// The one place a user-typed search term is made safe for an ILIKE pattern.

/**
 * A search term with the LIKE metacharacters (`\`, `%`, `_`) escaped, so the
 * typed text always matches literally — a search for "100%" can never
 * degenerate into match-everything.
 */
export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}
