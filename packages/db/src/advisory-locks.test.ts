import { describe, expect, it } from 'vitest';
import * as advisoryLocks from './advisory-locks';

describe('advisory-lock registry', () => {
  it('assigns a unique class to every (class, key)-space lock', () => {
    // A per-owner/per-track key is `hashtext(id)`, which can be 0, so two locks
    // that share a class can collide on the same (class, key) coordinate and
    // serialize unrelated work behind each other. Distinct classes make that
    // impossible. This asserts the registry stays the single source of truth:
    // every new lock must be added here, and no two may share a value.
    const classEntries = Object.entries(advisoryLocks).filter(([name]) =>
      name.endsWith('_LOCK_CLASS'),
    );
    const values = classEntries.map(([, value]) => value);
    expect(classEntries.length).toBeGreaterThan(1);
    expect(new Set(values).size).toBe(values.length);
  });
});
