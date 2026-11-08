import { describe, expect, it } from 'vitest';
import { parseUnitCostsForm, unitCostsFormValues } from './costs-panel-model';

describe('unit costs form', () => {
  it('shows stored prices as plain dollar strings and parses them back to a patch', () => {
    expect(unitCostsFormValues({ perTrackUsd: 0.05, perCoverUsd: 0 })).toEqual({
      perTrackUsd: '0.05',
      perCoverUsd: '0',
    });
    const parsed = parseUnitCostsForm({ perTrackUsd: ' 0.05 ', perCoverUsd: '0,10' });
    expect(parsed).toEqual({ ok: true, patch: { perTrackUsd: 0.05, perCoverUsd: 0.1 } });
  });

  it('names the field that is blank, non-numeric, negative, or below a cent', () => {
    const parsed = parseUnitCostsForm({ perTrackUsd: 'abc', perCoverUsd: '0.005' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.perTrackUsd).toBeTruthy();
    expect(parsed.errors.perCoverUsd).toBeTruthy();
    expect(parseUnitCostsForm({ perTrackUsd: '', perCoverUsd: '-1' })).toMatchObject({
      ok: false,
      errors: { perTrackUsd: expect.any(String), perCoverUsd: expect.any(String) },
    });
  });
});
