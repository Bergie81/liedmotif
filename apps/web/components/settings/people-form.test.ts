import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PeopleForm } from './people-form';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

describe('People settings form', () => {
  beforeAll(() => vi.stubGlobal('React', React));
  afterAll(() => vi.unstubAllGlobals());

  it('keeps the existing People visible and disables creation at the owner cap', () => {
    const people = Array.from({ length: 6 }, (_, index) => ({
      id: `person-${index}`,
      role: index === 0 ? ('owner' as const) : ('ordinary' as const),
      name: index === 0 ? 'Owner' : `Person ${index}`,
      about: '',
      photos: [],
    }));
    const markup = renderToStaticMarkup(
      React.createElement(PeopleForm, {
        initialPeople: people,
        initialFrequency: 'never',
        maxPeople: 6,
        maxNameLength: 120,
        maxAboutLength: 2_000,
        maxPhotosPerPerson: 3,
        maxPhotosTotal: 18,
      }),
    );

    expect(markup).toContain('6 of 6');
    expect(markup).toContain('6 of 6 People added');
    expect(markup).toMatch(
      /<button[^>]*disabled=""[^>]*>[^<]*(?:<svg[\s\S]*?<\/svg>)?6 of 6 People added/,
    );
    expect(markup).toMatch(
      /<input[^>]*type="radio"[^>]*name="cover-reference-frequency"[^>]*checked=""[^>]*value="never"/,
    );
  });
});
