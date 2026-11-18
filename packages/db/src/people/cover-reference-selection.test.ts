import { describe, expect, it } from 'vitest';
import {
  selectPersonCoverReferences,
  type CoverReferenceEndpointCapabilities,
} from './cover-reference-selection';

// Explicit opt-in mode: the caller (a Playlist cover attempt whose owner switched
// the People toggle on) asked for reference photos, so the selection must be
// deterministic — no frequency roll — and must refuse rather than hand back a
// prompt-only selection. The frequency-driven callers are covered beside the
// worker's cover reference policy.

const OWNER_ID = 'explicit-opt-in-owner';

const CAPABILITIES: CoverReferenceEndpointCapabilities = {
  references: {
    roles: ['subject'],
    maxCount: 3,
    mediaTypes: ['image/webp'],
    maxBytesPerReference: 1_000,
    maxTotalBytes: 3_000,
  },
};

const people = [
  { id: 'owner-person', role: 'owner', name: 'John', nameMatchKey: 'john', sortOrder: 0 },
  { id: 'julia-person', role: 'ordinary', name: 'Julia', nameMatchKey: 'julia', sortOrder: 1 },
  { id: 'amina-person', role: 'ordinary', name: 'Amina', nameMatchKey: 'amina', sortOrder: 2 },
] as const;

const photos = [
  { id: 'owner-1', personId: 'owner-person', mediaType: 'image/webp', byteSize: 100 },
  { id: 'owner-2', personId: 'owner-person', mediaType: 'image/webp', byteSize: 100 },
  { id: 'julia-1', personId: 'julia-person', mediaType: 'image/webp', byteSize: 100 },
  { id: 'amina-1', personId: 'amina-person', mediaType: 'image/webp', byteSize: 100 },
] as const;

/** A context the `seldom` roll excludes, so the opt-in is what admits the owner. */
const UNROLLED_CONTEXT = '00000000-0000-4000-8000-000000000000';

/** A second attempt id, which ranks the owner's two photos the other way round. */
const OTHER_CONTEXT = '00000000-0000-4000-8000-000000000004';

function select(overrides: Partial<Parameters<typeof selectPersonCoverReferences>[0]> = {}) {
  return selectPersonCoverReferences({
    frequency: 'seldom',
    ownerUserId: OWNER_ID,
    contextId: UNROLLED_CONTEXT,
    promptText: 'Late night drive',
    people,
    photos,
    capabilities: CAPABILITIES,
    ...overrides,
  });
}

describe('explicit opt-in cover reference selection', () => {
  it('includes the owner Person without a frequency roll when no name matches', () => {
    expect(select({ explicitOptIn: true })).toEqual({
      selectedPersonId: 'owner-person',
      selectedPersonIds: ['owner-person'],
      selectedPersonNames: ['John'],
      selectedReferences: [
        { id: 'owner-1', personId: 'owner-person', role: 'subject' },
        { id: 'owner-2', personId: 'owner-person', role: 'subject' },
      ],
      listenerPersonId: null,
      terminalReason: null,
    });
  });

  it.each(['seldom', 'regularly', 'always'] as const)(
    'admits the owner under %s regardless of the roll',
    (frequency) => {
      expect(select({ explicitOptIn: true, frequency }).selectedPersonId).toBe('owner-person');
    },
  );

  it('leaves the frequency roll in charge without the opt-in', () => {
    expect(select()).toMatchObject({ selectedPersonId: null, selectedReferences: [] });
  });

  it('lets never outrank the opt-in: nothing selected, and the request refused', () => {
    expect(select({ explicitOptIn: true, frequency: 'never' })).toEqual({
      selectedPersonId: null,
      selectedPersonIds: [],
      selectedPersonNames: [],
      selectedReferences: [],
      listenerPersonId: null,
      terminalReason: 'privacy_rejected',
    });
  });

  it('keeps never silent for a frequency-driven caller', () => {
    expect(select({ frequency: 'never' })).toMatchObject({
      selectedReferences: [],
      terminalReason: null,
    });
  });

  it('matches named People over the owner fallback, one photo each in configured order', () => {
    const result = select({ explicitOptIn: true, promptText: 'Amina and Julia at the beach' });
    expect(result.selectedPersonIds).toEqual(['julia-person', 'amina-person']);
    expect(result.selectedReferences).toEqual([
      { id: 'julia-1', personId: 'julia-person', role: 'subject' },
      { id: 'amina-1', personId: 'amina-person', role: 'subject' },
    ]);
    expect(result.terminalReason).toBeNull();
  });

  it.each([
    ['no configured People at all', { people: [] }],
    ['no reference photos to send', { photos: [] }],
  ])('refuses when the opt-in has nothing to send: %s', (_case, overrides) => {
    const result = select({ explicitOptIn: true, ...overrides });
    expect(result.selectedReferences).toEqual([]);
    expect(result.terminalReason).toBe('references_unsupported');
  });

  it('refuses when the endpoint accepts no references, recording the frozen choice', () => {
    const result = select({ explicitOptIn: true, capabilities: { references: null } });
    expect(result.selectedReferences.map((reference) => reference.id)).toEqual([
      'owner-1',
      'owner-2',
    ]);
    expect(result.terminalReason).toBe('references_unsupported');
  });

  it('lets a name match without photos stay prompt-only when the opt-in is off', () => {
    expect(select({ promptText: 'A song for Julia', photos: [] })).toMatchObject({
      selectedPersonId: 'julia-person',
      selectedReferences: [],
      terminalReason: null,
    });
  });

  it('ranks the same photos differently for each attempt it selects for', () => {
    // An endpoint with room for one reference makes the ranking observable: the
    // owner has two photos and only the better-ranked one travels. The rank is
    // keyed on the context, so two attempts over one unchanged photo set do not
    // both settle on the same row — which is what keeps a Playlist's repeated
    // cover generations from wearing the same face every time.
    const oneReference: CoverReferenceEndpointCapabilities = {
      references: { ...CAPABILITIES.references!, maxCount: 1 },
    };
    const chosen = (contextId: string) =>
      select({ explicitOptIn: true, contextId, capabilities: oneReference }).selectedReferences.map(
        (reference) => reference.id,
      );

    expect(chosen(UNROLLED_CONTEXT)).toEqual(['owner-1']);
    expect(chosen(OTHER_CONTEXT)).toEqual(['owner-2']);
  });
});

// The Session's request put the listener in its scene ("me, Julia and Amina"):
// the owner Person is a named subject like the others, not the no-name fallback.
describe('cover reference selection for a request that includes the listener', () => {
  it('adds the owner to the named People, one photo each in configured order', () => {
    const result = select({ owner: 'include', promptText: 'Me, Amina and Julia at the beach' });
    expect(result.selectedPersonIds).toEqual(['owner-person', 'julia-person', 'amina-person']);
    expect(result.selectedPersonNames).toEqual(['John', 'Julia', 'Amina']);
    expect(result.selectedReferences.map((reference) => reference.personId)).toEqual([
      'owner-person',
      'julia-person',
      'amina-person',
    ]);
    expect(result.listenerPersonId).toBe('owner-person');
    expect(result.terminalReason).toBeNull();
  });

  it('selects the owner without a frequency roll when no other name matches', () => {
    expect(select({ owner: 'include', promptText: 'Me on a trip to the moon' })).toMatchObject({
      selectedPersonIds: ['owner-person'],
      selectedReferences: [
        { id: 'owner-1', personId: 'owner-person', role: 'subject' },
        { id: 'owner-2', personId: 'owner-person', role: 'subject' },
      ],
      terminalReason: null,
    });
  });

  it('counts an owner named by name once', () => {
    const result = select({ owner: 'include', promptText: 'John and Julia at the beach' });
    expect(result.selectedPersonIds).toEqual(['owner-person', 'julia-person']);
  });

  it('keeps named People without the owner when the request leaves the listener out', () => {
    const result = select({ promptText: 'Amina and Julia at the beach' });
    expect(result.selectedPersonIds).toEqual(['julia-person', 'amina-person']);
    expect(result.listenerPersonId).toBeNull();
  });

  it('marks no listener for an owner chosen by name alone', () => {
    expect(select({ promptText: 'John and Julia at the beach' }).listenerPersonId).toBeNull();
  });

  it('lets never outrank it: no Person selected, nothing refused', () => {
    expect(
      select({ owner: 'include', frequency: 'never', promptText: 'Me and Julia at the beach' }),
    ).toMatchObject({ selectedPersonIds: [], selectedReferences: [], terminalReason: null });
  });
});

// "Run without my profile details" removes the owner's own details from one
// Session. The People the request names are the request's, so they stay.
describe('cover reference selection for a Session run without the owner’s profile', () => {
  it('keeps the named People and leaves the owner out, named or not', () => {
    const result = select({
      owner: 'exclude',
      promptText: 'John, Amina and Julia at the beach',
    });
    expect(result.selectedPersonIds).toEqual(['julia-person', 'amina-person']);
    expect(result.selectedReferences.map((reference) => reference.personId)).toEqual([
      'julia-person',
      'amina-person',
    ]);
  });

  it('never hands the owner’s name to a Person whose name is part of it', () => {
    const result = select({
      owner: 'exclude',
      frequency: 'always',
      people: [
        {
          id: 'owner-person',
          role: 'owner',
          name: 'Anna Müller',
          nameMatchKey: 'anna müller',
          sortOrder: 0,
        },
        { id: 'anna-person', role: 'ordinary', name: 'Anna', nameMatchKey: 'anna', sortOrder: 1 },
      ],
      photos: [
        { id: 'owner-1', personId: 'owner-person', mediaType: 'image/webp', byteSize: 100 },
        { id: 'anna-1', personId: 'anna-person', mediaType: 'image/webp', byteSize: 100 },
      ],
      promptText: 'Anna Müller at the beach',
    });
    expect(result).toMatchObject({ selectedPersonIds: [], selectedReferences: [] });
  });

  it('never falls back to the owner when nobody else is named', () => {
    expect(
      select({ owner: 'exclude', frequency: 'always', promptText: 'Late night drive' }),
    ).toMatchObject({ selectedPersonIds: [], selectedReferences: [], terminalReason: null });
  });
});
