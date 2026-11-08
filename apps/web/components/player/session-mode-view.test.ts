import { describe, expect, it } from 'vitest';
import { SESSION_MODES } from '@liedmotif/shared';
import { SESSION_MODE_LABEL } from './session-mode-view';

describe('SESSION_MODE_LABEL', () => {
  it('names every domain mode by what it does to generation', () => {
    expect(Object.keys(SESSION_MODE_LABEL).sort()).toEqual([...SESSION_MODES].sort());
    expect(SESSION_MODE_LABEL.keep_going).toBe('Generate new Tracks');
    expect(SESSION_MODE_LABEL.repeat).toBe('Play existing Tracks');
  });
});
