import { describe, expect, it } from 'vitest';
import { MAX_USER_PROMPT_LENGTH } from '@liedmotif/shared';
import { homeIntentHref, intentFromParam } from './intent-prefill';

describe('homeIntentHref / intentFromParam — the hand-off round-trip', () => {
  it('URL-encodes the query and reads it back intact', () => {
    const href = homeIntentHref('rainy 40-minute run & more');
    expect(href).toBe('/?intent=rainy%2040-minute%20run%20%26%20more');
    const url = new URL(href, 'http://localhost');
    expect(intentFromParam(url.searchParams.get('intent') ?? undefined)).toBe(
      'rainy 40-minute run & more',
    );
  });

  it('treats an absent, empty or blank parameter as no prefill', () => {
    expect(intentFromParam(undefined)).toBeNull();
    expect(intentFromParam('')).toBeNull();
    expect(intentFromParam('   ')).toBeNull();
  });

  it('takes the first value of a repeated parameter and bounds the length', () => {
    expect(intentFromParam(['first', 'second'])).toBe('first');
    expect(intentFromParam('x'.repeat(MAX_USER_PROMPT_LENGTH + 50))).toHaveLength(
      MAX_USER_PROMPT_LENGTH,
    );
  });
});
