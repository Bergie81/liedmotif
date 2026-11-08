import { describe, expect, it } from 'vitest';
import { SEARCH_MATCH_FIELDS } from '@liedmotif/shared';
import { highlightSnippet, MATCH_FIELD_LABELS } from './match-context';

describe('highlightSnippet', () => {
  it('splits around a match at the start, middle and end', () => {
    expect(highlightSnippet('rainy run mix', 'rainy')).toEqual([
      { text: 'rainy', hit: true },
      { text: ' run mix', hit: false },
    ]);
    expect(highlightSnippet('a rainy run', 'rainy')).toEqual([
      { text: 'a ', hit: false },
      { text: 'rainy', hit: true },
      { text: ' run', hit: false },
    ]);
    expect(highlightSnippet('always rainy', 'rainy')).toEqual([
      { text: 'always ', hit: false },
      { text: 'rainy', hit: true },
    ]);
  });

  it('highlights repeated occurrences case-insensitively', () => {
    const parts = highlightSnippet('Rain, rain, go away', 'rain');
    expect(parts.filter((part) => part.hit).map((part) => part.text)).toEqual(['Rain', 'rain']);
  });

  it('matches a query containing regex-special characters literally', () => {
    expect(highlightSnippet('learn c++ fast', 'c++')).toEqual([
      { text: 'learn ', hit: false },
      { text: 'c++', hit: true },
      { text: ' fast', hit: false },
    ]);
  });

  it('renders a snippet without the query unhighlighted rather than throwing', () => {
    expect(highlightSnippet('nothing here', 'absent')).toEqual([
      { text: 'nothing here', hit: false },
    ]);
    expect(highlightSnippet('anything', '  ')).toEqual([{ text: 'anything', hit: false }]);
  });
});

describe('MATCH_FIELD_LABELS', () => {
  it('labels every field in the shared union', () => {
    for (const field of SEARCH_MATCH_FIELDS) {
      expect(MATCH_FIELD_LABELS[field]).toBeTruthy();
    }
  });
});
