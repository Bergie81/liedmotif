import { describe, expect, it } from 'vitest';
import { canonicalPersonName, matchConfiguredPeople, replaceConfiguredPersonNames } from './people';

describe('canonical Person names', () => {
  it.each([
    [' Julia ', 'julia'],
    ['Ｊｕｌｉａ', 'julia'],
    ['JOSE\u0301', 'josé'],
    ['Σίσυφος', 'σίσυφοσ'],
    ['STRAẞE', 'strasse'],
  ])('normalizes %j to %j', (name, expected) => {
    expect(canonicalPersonName(name)).toBe(expected);
  });

  it('collapses internal whitespace without transliterating writing systems', () => {
    expect(canonicalPersonName('  李   小龍  ')).toBe('李 小龍');
  });
});

describe('exact configured Person matching', () => {
  const people = [
    { id: 'julia', name: 'Julia', nameMatchKey: 'julia' },
    { id: 'jose', name: 'José', nameMatchKey: 'josé' },
    { id: 'li', name: '李小龍', nameMatchKey: '李小龍' },
    { id: 'maria', name: 'María Sol', nameMatchKey: 'maría sol' },
  ];

  it.each([
    ['A birthday song for JULIA', ['julia']],
    ['A homecoming for JOSE\u0301', ['jose']],
    ['祝 李小龍 生日快樂', ['li']],
    ['Dance with María   Sol tonight', ['maria']],
    ["Julia's quiet morning", ['julia']],
  ])('matches configured names in %j', (context, ids) => {
    expect(matchConfiguredPeople(context, people).map((person) => person.id)).toEqual(ids);
  });

  it.each(['wife', 'my wife', 'meine Frau', 'me', 'myself', 'Julian', 'María'])(
    'does not infer a configured Person from %j',
    (context) => {
      expect(matchConfiguredPeople(context, people)).toEqual([]);
    },
  );
});

describe('configured Person replacement', () => {
  it('uses the exact matcher folding rules while assigning stable labels', () => {
    const people = [
      { id: 'street', name: 'Straße', nameMatchKey: 'strasse' },
      { id: 'greek', name: 'Σίσυφος', nameMatchKey: 'σίσυφοσ' },
    ];
    expect(
      replaceConfiguredPersonNames('STRASSE meets Σίσυφος', people, (_person, index) =>
        index === 0 ? 'subject one' : 'subject two',
      ),
    ).toBe('subject one meets subject two');
  });

  it('prefers the longest configured name when exact matches overlap', () => {
    const people = [
      { id: 'ann', name: 'Ann', nameMatchKey: 'ann' },
      { id: 'ann-marie', name: 'Ann Marie', nameMatchKey: 'ann marie' },
    ];
    expect(
      matchConfiguredPeople('A song for Ann Marie', people).map((person) => person.id),
    ).toEqual(['ann-marie']);
    expect(
      replaceConfiguredPersonNames(
        'Ann Marie arrives',
        people,
        (_person, index) => `subject ${index + 1}`,
      ),
    ).toBe('subject 2 arrives');
  });
});
