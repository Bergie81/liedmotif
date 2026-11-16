'use client';

import { useState } from 'react';

/**
 * A choice a settings form holds, seeded from the value the page read. When the
 * page reads a different stored value (the Assistant changed it past the form)
 * the form shows that one. A form re-reads its page after each save of its own,
 * so a later change back to the first value still reads as a change.
 */
export function useStoredValue<T>(stored: T): [T, (value: T) => void] {
  const [value, setValue] = useState(stored);
  const [seen, setSeen] = useState(stored);
  if (!Object.is(stored, seen)) {
    setSeen(stored);
    setValue(stored);
  }
  return [value, setValue];
}
