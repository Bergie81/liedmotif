import { describe, expect, it } from 'vitest';
import type { GeneratedImageCapabilities } from '@liedmotif/providers';
import { selectPersonReferences } from './cover-reference-policy';

const OWNER_ID = 'reference-frequency-owner';

const CAPABILITIES: GeneratedImageCapabilities = {
  provider: { providerType: 'image', providerKey: 'test', model: 'test/image' },
  exclusions: 'native',
  nativeSeed: false,
  idempotency: 'absent',
  references: {
    roles: ['subject'],
    maxCount: 3,
    multiSubjectIdentity: false,
    mediaTypes: ['image/webp'],
    maxBytesPerReference: 1_000,
    maxTotalBytes: 3_000,
  },
  squareOutput: 'native',
  maxCandidates: 1,
  costReporting: false,
};

const people = [
  { id: 'owner-person', role: 'owner', name: 'John', nameMatchKey: 'john', sortOrder: 0 },
  { id: 'julia-person', role: 'ordinary', name: 'Julia', nameMatchKey: 'julia', sortOrder: 1 },
  { id: 'li-person', role: 'ordinary', name: '李小龍', nameMatchKey: '李小龍', sortOrder: 2 },
  { id: 'amina-person', role: 'ordinary', name: 'Amina', nameMatchKey: 'amina', sortOrder: 3 },
  { id: 'zoe-person', role: 'ordinary', name: 'Zoë', nameMatchKey: 'zoë', sortOrder: 4 },
  { id: 'omar-person', role: 'ordinary', name: 'Omar', nameMatchKey: 'omar', sortOrder: 5 },
] as const;

const photos = [
  { id: 'owner-1', personId: 'owner-person', mediaType: 'image/webp', byteSize: 100 },
  { id: 'owner-2', personId: 'owner-person', mediaType: 'image/webp', byteSize: 100 },
  { id: 'julia-1', personId: 'julia-person', mediaType: 'image/webp', byteSize: 100 },
  { id: 'julia-2', personId: 'julia-person', mediaType: 'image/webp', byteSize: 100 },
  { id: 'julia-3', personId: 'julia-person', mediaType: 'image/webp', byteSize: 100 },
  { id: 'li-1', personId: 'li-person', mediaType: 'image/webp', byteSize: 100 },
  { id: 'amina-1', personId: 'amina-person', mediaType: 'image/webp', byteSize: 100 },
  { id: 'amina-2', personId: 'amina-person', mediaType: 'image/webp', byteSize: 100 },
  { id: 'zoe-1', personId: 'zoe-person', mediaType: 'image/webp', byteSize: 100 },
  { id: 'omar-1', personId: 'omar-person', mediaType: 'image/webp', byteSize: 100 },
] as const;

function select(overrides: Partial<Parameters<typeof selectPersonReferences>[0]> = {}) {
  return selectPersonReferences({
    frequency: 'seldom',
    ownerUserId: OWNER_ID,
    contextId: '00000000-0000-4000-8000-000000000000',
    promptText: 'A birthday song for Julia',
    people,
    photos,
    capabilities: CAPABILITIES,
    ...overrides,
  });
}

describe('single-Person cover reference selection', () => {
  it('uses all persisted photos for one exact named Person in order', () => {
    expect(select()).toEqual({
      selectedPersonId: 'julia-person',
      selectedPersonIds: ['julia-person'],
      selectedPersonNames: ['Julia'],
      selectedReferences: [
        { id: 'julia-1', personId: 'julia-person', role: 'subject' },
        { id: 'julia-2', personId: 'julia-person', role: 'subject' },
        { id: 'julia-3', personId: 'julia-person', role: 'subject' },
      ],
      terminalReason: null,
    });
  });

  it.each([
    ['A song for JULIA', 'julia-person'],
    ['祝 李小龍 生日快樂', 'li-person'],
  ])('matches exact names after Unicode normalization in %j', (promptText, personId) => {
    expect(select({ promptText }).selectedPersonId).toBe(personId);
  });

  it.each(['wife', 'my wife', 'meine Frau', 'me', 'myself'])(
    'does not infer a Person from %j',
    (promptText) => {
      expect(select({ promptText, people: people.slice(1), photos }).selectedPersonId).toBeNull();
    },
  );

  it.each([
    ['always', '00000000-0000-4000-8000-000000000000', true],
    ['regularly', '00000000-0000-4000-8000-000000000002', true],
    ['seldom', '00000000-0000-4000-8000-000000000007', true],
    ['seldom', '00000000-0000-4000-8000-000000000000', false],
    ['never', '00000000-0000-4000-8000-000000000007', false],
  ] as const)('applies %s owner fallback deterministically', (frequency, contextId, included) => {
    const result = select({ frequency, contextId, promptText: 'Rainy instrumental focus' });
    expect(result.selectedPersonId).toBe(included ? 'owner-person' : null);
    expect(result.selectedReferences.map((reference) => reference.id)).toEqual(
      included ? ['owner-1', 'owner-2'] : [],
    );
  });

  it('uses a stable deterministic subset when the endpoint accepts fewer photos', () => {
    const capabilities = {
      ...CAPABILITIES,
      references: { ...CAPABILITIES.references!, maxCount: 2 },
    };
    const first = select({ capabilities });
    expect(first.selectedReferences).toHaveLength(2);
    expect(select({ capabilities })).toEqual(first);
  });

  it('settles terminally when a selected Person has photos but the endpoint accepts none', () => {
    expect(select({ capabilities: { ...CAPABILITIES, references: null } })).toMatchObject({
      selectedPersonId: 'julia-person',
      terminalReason: 'references_unsupported',
    });
  });

  it('allows ordinary prompt-only generation for a named Person without photos', () => {
    expect(select({ photos: photos.filter((photo) => photo.personId !== 'julia-person') })).toEqual(
      {
        selectedPersonId: 'julia-person',
        selectedPersonIds: ['julia-person'],
        selectedPersonNames: ['Julia'],
        selectedReferences: [],
        terminalReason: null,
      },
    );
  });
});

describe('multi-Person cover reference selection', () => {
  it('chooses exactly one ordered photo per named reference-bearing Person', () => {
    const result = select({ promptText: 'Amina, Julia, and 李小龍 at home' });
    expect(result.selectedPersonIds).toEqual(['julia-person', 'li-person', 'amina-person']);
    expect(result.selectedReferences.map(({ personId }) => personId)).toEqual([
      'julia-person',
      'li-person',
      'amina-person',
    ]);
    expect(result.selectedReferences).toHaveLength(3);
    expect(result.terminalReason).toBeNull();
  });

  it('keeps photo choices stable for one Session and varies them across fixed Sessions', () => {
    const promptText = 'Julia and Amina together';
    const first = select({ contextId: 'session-1', promptText });
    expect(select({ contextId: 'session-1', promptText })).toEqual(first);
    const choices = ['session-1', 'session-2', 'session-3', 'session-4'].map((contextId) =>
      select({ contextId, promptText })
        .selectedReferences.map(({ id }) => id)
        .join(','),
    );
    expect(new Set(choices).size).toBeGreaterThan(1);
  });

  it('does not count a named Person without photos toward endpoint capacity', () => {
    const result = select({
      promptText: 'Julia and 李小龍 together',
      photos: photos.filter((photo) => photo.personId !== 'li-person'),
      capabilities: {
        ...CAPABILITIES,
        references: { ...CAPABILITIES.references!, maxCount: 1 },
      },
    });
    expect(result.selectedPersonIds).toEqual(['julia-person', 'li-person']);
    expect(result.selectedReferences).toHaveLength(1);
    expect(result.selectedReferences[0]!.personId).toBe('julia-person');
    expect(result.terminalReason).toBeNull();
  });

  it('settles when count or total-byte capacity cannot retain every reference-bearing Person', () => {
    const promptText = 'Julia and Amina together';
    for (const references of [
      { ...CAPABILITIES.references!, maxCount: 1 },
      { ...CAPABILITIES.references!, maxTotalBytes: 150 },
    ]) {
      const result = select({ promptText, capabilities: { ...CAPABILITIES, references } });
      expect(result.selectedReferences.map(({ personId }) => personId)).toEqual([
        'julia-person',
        'amina-person',
      ]);
      expect(result.terminalReason).toBe('references_unsupported');
    }
  });

  it('ignores diagnostic multi-subject identity when transport limits are sufficient', () => {
    expect(
      select({ promptText: 'Julia and Amina together' }).selectedReferences.map(
        ({ personId }) => personId,
      ),
    ).toEqual(['julia-person', 'amina-person']);
  });

  it('keeps all six named People in configured order', () => {
    const capabilities = {
      ...CAPABILITIES,
      references: { ...CAPABILITIES.references!, maxCount: 6, maxTotalBytes: 6_000 },
    };
    const result = select({
      promptText: 'Omar, Amina, John, Julia, Zoë, and 李小龍 together',
      capabilities,
    });
    expect(result.selectedReferences.map(({ personId }) => personId)).toEqual(
      people.map(({ id }) => id),
    );
    expect(result.terminalReason).toBeNull();
  });
});
