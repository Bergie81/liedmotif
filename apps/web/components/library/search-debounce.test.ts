import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSearchDebouncer, SEARCH_DEBOUNCE_MS } from './search-debounce';

// The Library search fires only after the typist goes quiet: 500ms of
// inactivity, trimmed, and never re-announcing a query that already ran.

describe('createSearchDebouncer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('emits the trimmed query after the quiet period', () => {
    const emitted: string[] = [];
    const debouncer = createSearchDebouncer((q) => emitted.push(q));

    debouncer.input('  piano ');
    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(emitted).toEqual(['piano']);
  });

  it('restarts the quiet period on every keystroke', () => {
    const emitted: string[] = [];
    const debouncer = createSearchDebouncer((q) => emitted.push(q));

    debouncer.input('p');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 100);
    debouncer.input('pi');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 100);
    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(emitted).toEqual(['pi']);
  });

  it('does not re-emit a query that already ran', () => {
    const emitted: string[] = [];
    const debouncer = createSearchDebouncer((q) => emitted.push(q));

    debouncer.input('piano');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    debouncer.input('pianos');
    debouncer.input('piano ');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    expect(emitted).toEqual(['piano']);
  });

  it('emits the cleared query so results reset', () => {
    const emitted: string[] = [];
    const debouncer = createSearchDebouncer((q) => emitted.push(q));

    debouncer.input('piano');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    debouncer.input('');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    expect(emitted).toEqual(['piano', '']);
  });

  it('cancel drops the pending emit', () => {
    const emitted: string[] = [];
    const debouncer = createSearchDebouncer((q) => emitted.push(q));

    debouncer.input('piano');
    debouncer.cancel();
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
    expect(emitted).toEqual([]);
  });

  it('measures the next input against a query committed elsewhere', () => {
    const emitted: string[] = [];
    const debouncer = createSearchDebouncer((q) => emitted.push(q));

    debouncer.input('jazz');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    // Cleared outside the debouncer: typing the same words again is a new search.
    debouncer.sync('');
    debouncer.input('jazz');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    // A Recent committed outside it: re-typing that query announces nothing.
    debouncer.input('lofi ');
    debouncer.sync('lofi');
    debouncer.input('lofi');
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    expect(emitted).toEqual(['jazz', 'jazz']);
  });
});
