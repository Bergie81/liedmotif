// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useStoredValue } from './use-stored-value';

describe('a settings choice held by its form', () => {
  it('keeps what the user picked while the stored value stays as it was', () => {
    const { result, rerender } = renderHook(({ stored }) => useStoredValue(stored), {
      initialProps: { stored: 'seldom' },
    });

    act(() => result.current[1]('always'));
    rerender({ stored: 'seldom' });

    expect(result.current[0]).toBe('always');
  });

  it('follows the stored value when it moves past the form, back to the first one included', () => {
    const { result, rerender } = renderHook(({ stored }) => useStoredValue(stored), {
      initialProps: { stored: 'seldom' },
    });

    // Saved here, and the page re-read after the save.
    act(() => result.current[1]('always'));
    rerender({ stored: 'always' });
    // Changed back past the form, by the Assistant.
    rerender({ stored: 'seldom' });

    expect(result.current[0]).toBe('seldom');
  });
});
