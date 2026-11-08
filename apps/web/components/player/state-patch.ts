// Structural no-op detection for polled state patches. A queue poll rebuilds
// its projection objects every time, so identity alone would re-render the
// whole player tree (and the app shell subscribed to its context) every few
// seconds even when the server said nothing new. Values are compared
// structurally; the data is contract-shaped JSON, so plain recursion suffices.

function valueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => valueEqual(item, b[index]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (Array.isArray(a) || Array.isArray(b)) return false;
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key) =>
        valueEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
      )
    );
  }
  return false;
}

/** True when applying `patch` to `state` would change nothing — the caller
 * then keeps the previous state object so React bails out of the render. */
export function patchLeavesStateUnchanged<T extends object>(state: T, patch: Partial<T>): boolean {
  return Object.entries(patch).every(([key, next]) =>
    valueEqual((state as Record<string, unknown>)[key], next),
  );
}
