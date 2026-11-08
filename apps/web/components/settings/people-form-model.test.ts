import { describe, expect, it } from 'vitest';
import {
  mergePersonNames,
  namedPeopleCount,
  ownerCoverFallbackReady,
  validatePersonFields,
} from './people-form-model';

describe('Person field validation', () => {
  it('reports a blank name beside the name field', () => {
    expect(
      validatePersonFields({ name: '  ', about: '', maxNameLength: 120, maxAboutLength: 2_000 }),
    ).toEqual({ name: 'Enter a Person name.' });
  });

  it('enforces the same name and About caps as the server', () => {
    expect(
      validatePersonFields({
        name: 'x'.repeat(4),
        about: 'y'.repeat(6),
        maxNameLength: 3,
        maxAboutLength: 5,
      }),
    ).toEqual({
      name: 'Name must be at most 3 characters.',
      about: 'About must be at most 5 characters.',
    });
  });
});

describe('namedPeopleCount', () => {
  it('counts only People who actually have a name', () => {
    expect(namedPeopleCount([{ name: 'John' }, { name: '  ' }, { name: 'Jane' }])).toBe(2);
  });
});

describe('the no-name Cover fallback', () => {
  const owner = { id: 'p1', role: 'owner' as const, name: 'John', photos: [] };
  const jane = { id: 'p2', role: 'ordinary' as const, name: 'Jane', photos: [{ id: 'ph2' }] };
  const photographed = [{ ...owner, photos: [{ id: 'ph1' }] }, jane];

  it('is ready once the owner has a reference photo of their own', () => {
    expect(ownerCoverFallbackReady(photographed)).toBe(true);
  });

  it('is not ready while the owner has no photo, whoever else has one', () => {
    // The fallback puts the OWNER on a Cover, so another Person's photo cannot stand
    // in for a likeness of them.
    expect(ownerCoverFallbackReady([owner, jane])).toBe(false);
  });

  it('is not ready before the roster has loaded an owner at all', () => {
    expect(ownerCoverFallbackReady([])).toBe(false);
  });
});

describe('mergePersonNames', () => {
  const photo = { id: 'ph1', personId: 'p1' };
  const roster = [
    { id: 'p1', role: 'owner' as const, name: 'Liedmotif', about: 'me', photos: [photo] },
    { id: 'p2', role: 'ordinary' as const, name: 'Jane', about: '', photos: [] },
  ];

  it('takes the server’s name without dropping locally-held photos', () => {
    const merged = mergePersonNames(roster, [
      { id: 'p1', role: 'owner', name: 'John', about: 'me' },
    ]);
    expect(merged[0]).toEqual({ ...roster[0], name: 'John' });
  });

  it('leaves a Person the server did not report', () => {
    expect(mergePersonNames(roster, [])).toEqual(roster);
    expect(
      mergePersonNames(roster, [{ id: 'p1', role: 'owner', name: 'John', about: 'me' }])[1],
    ).toEqual(roster[1]);
  });
});
