import { describe, expect, it } from 'vitest';
import { normalizeExtension, storageKeys } from './index';

describe('normalizeExtension', () => {
  it('strips leading dots and lowercases', () => {
    expect(normalizeExtension('.MP3')).toBe('mp3');
    expect(normalizeExtension('WEBP')).toBe('webp');
    expect(normalizeExtension('..jpeg')).toBe('jpeg');
  });
});

describe('storageKeys', () => {
  it('groups a track under its session folder, named by title slug + short id', () => {
    expect(
      storageKeys.trackOriginal(
        'user-1',
        storageKeys.sessionAudioFolder({
          id: 'aaaabbbb-cccc-dddd-eeee-ffff00001111',
          title: 'Calm Focus · Lo-fi!',
        }),
        { id: '11112222-3333-4444-5555-666677778888', title: 'Calm Focus 1' },
        '.mp3',
      ),
    ).toBe('tracks/user-1/calm-focus-lo-fi-aaaabbbb/calm-focus-1-11112222.mp3');
  });

  it('falls back to bare id segments for null titles and no session', () => {
    expect(
      storageKeys.trackOriginal(
        'user-1',
        storageKeys.sessionAudioFolder({ id: 'aaaabbbb-cccc-dddd-eeee-ffff00001111', title: null }),
        { id: '11112222-3333-4444-5555-666677778888', title: null },
        'mp3',
      ),
    ).toBe('tracks/user-1/session-aaaabbbb/track-11112222.mp3');
    expect(
      storageKeys.trackOriginal(
        'user-1',
        null,
        { id: '11112222-3333-4444-5555-666677778888', title: 'Drift 2' },
        'm4a',
      ),
    ).toBe('tracks/user-1/unsorted/drift-2-11112222.m4a');
  });

  it('slugs can never smuggle traversal into the key', () => {
    expect(
      storageKeys.trackOriginal(
        'user-1',
        storageKeys.sessionAudioFolder({
          id: 'aaaabbbb-cccc-dddd-eeee-ffff00001111',
          title: '../../etc/passwd',
        }),
        { id: '11112222-3333-4444-5555-666677778888', title: '..\\..\\evil' },
        'mp3',
      ),
    ).toBe('tracks/user-1/etc-passwd-aaaabbbb/evil-11112222.mp3');
  });

  it('builds the documented key layout', () => {
    expect(storageKeys.uploadedCover('user-1', 'cover-2', 'png')).toBe(
      'covers/uploaded/user-1/cover-2.png',
    );
    expect(storageKeys.avatar('user-1', 'avatar-2', 'webp')).toBe('avatars/user-1/avatar-2.webp');
    expect(storageKeys.personReferencePhoto('user-1', 'person-2', 'photo-3', 'WEBP')).toBe(
      'person-references/user-1/person-2/photo-3.webp',
    );
    expect(storageKeys.exportBundle('user-1', 'bundle-3')).toBe('exports/user-1/bundle-3.zip');
    expect(storageKeys.importBatch('user-1', 'batch-4')).toBe('imports/user-1/batch-4.json');
  });
});
