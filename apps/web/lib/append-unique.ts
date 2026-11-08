/**
 * Append a cursor page onto an already-loaded list, dropping rows the list
 * already has — activity-ordered keysets can hand back a row that moved while
 * paging, and a repeated id would break React keys and double-render the row.
 */
export function appendUniqueById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !seen.has(item.id))];
}
