// @vitest-environment jsdom

import { renderHook, act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSeededPrompt } from './use-seeded-prompt';

describe('useSeededPrompt — seeds once, never clobbers', () => {
  it('seeds the initial value and follows user edits', () => {
    const { result } = renderHook(() => useSeededPrompt('rainy run'));
    expect(result.current[0]).toBe('rainy run');
    act(() => result.current[1]('rainy run, no drums'));
    expect(result.current[0]).toBe('rainy run, no drums');
  });

  it('a later change to the initial value does not overwrite what the user typed', () => {
    const { result, rerender } = renderHook(({ initial }) => useSeededPrompt(initial), {
      initialProps: { initial: 'first hand-off' as string | undefined },
    });
    act(() => result.current[1]('my own words'));
    rerender({ initial: 'second hand-off' });
    expect(result.current[0]).toBe('my own words');
  });

  it('starts empty without a prefill', () => {
    const { result } = renderHook(() => useSeededPrompt(undefined));
    expect(result.current[0]).toBe('');
  });
});
