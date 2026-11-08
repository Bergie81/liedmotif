// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ChangeEvent } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { usePasswordConfirmation } from './password-field';

afterEach(cleanup);

function typed(value: string) {
  return { target: { value } } as ChangeEvent<HTMLInputElement>;
}

describe('password confirmation', () => {
  // A mistyped new password locks the account out — on setup, the only one.
  it('blocks a submit whose repeat differs and says so beside the field until both match', () => {
    const { result, rerender } = renderHook(({ password }) => usePasswordConfirmation(password), {
      initialProps: { password: 'Correct-Horse-42' },
    });
    act(() => result.current.field.onChange(typed('Correct-Horse-43')));
    expect(result.current.field.error).toBeUndefined();

    let submittable = true;
    act(() => {
      submittable = result.current.check();
    });
    expect(submittable).toBe(false);
    expect(result.current.field.error).toBe('Passwords do not match.');

    rerender({ password: 'Correct-Horse-43' });
    expect(result.current.field.error).toBeUndefined();
    act(() => {
      submittable = result.current.check();
    });
    expect(submittable).toBe(true);
  });
});
