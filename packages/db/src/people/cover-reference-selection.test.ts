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
