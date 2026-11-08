// The Library tabs' search timing model: a query runs only after the typist
// goes quiet, and an already-running query is never re-announced.

/** Quiet period before a Library search fires. */
export const SEARCH_DEBOUNCE_MS = 500;

export interface SearchDebouncer {
  /** Feed the raw input value; the trimmed query emits after the quiet period. */
  input(raw: string): void;
  /** Drop any pending emit (component unmount). */
  cancel(): void;
  /**
   * A query committed without the debouncer (Enter, Clear, a Recent): drop any
   * pending emit and measure the next input against it, not the last emit.
   */
  sync(query: string): void;
}

export function createSearchDebouncer(
  onSearch: (query: string) => void,
  delayMs: number = SEARCH_DEBOUNCE_MS,
): SearchDebouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastEmitted = '';

  function clear() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  return {
    input(raw: string) {
      clear();
      const query = raw.trim();
      if (query === lastEmitted) return;
      timer = setTimeout(() => {
        timer = null;
        lastEmitted = query;
        onSearch(query);
      }, delayMs);
    },
    cancel: clear,
    sync(query: string) {
      clear();
      lastEmitted = query.trim();
    },
  };
}
