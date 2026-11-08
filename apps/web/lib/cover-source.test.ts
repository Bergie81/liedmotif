import { describe, expect, it } from 'vitest';
import { coverSource } from './cover-source';

describe('coverSource', () => {
  const both = { tailoredCoverArtEnabled: true, musicProviderCoverConfigured: true };

  it('prefers the image model, which is the only source that can use People', () => {
    expect(coverSource({ ...both, imageProviderConfigured: true })).toBe('image');
  });

  it('falls to the music provider when the image model is switched off', () => {
    expect(
      coverSource({ ...both, tailoredCoverArtEnabled: false, imageProviderConfigured: true }),
    ).toBe('music-provider');
  });

  it('never promises an image model that is not configured', () => {
    expect(coverSource({ ...both, imageProviderConfigured: false })).toBe('music-provider');
    expect(
      coverSource({
        tailoredCoverArtEnabled: true,
        musicProviderCoverConfigured: false,
        imageProviderConfigured: false,
      }),
    ).toBe('none');
  });

  it('keeps the branded placeholder when neither source can paint', () => {
    expect(
      coverSource({
        tailoredCoverArtEnabled: false,
        musicProviderCoverConfigured: false,
        imageProviderConfigured: true,
      }),
    ).toBe('none');
  });
});
