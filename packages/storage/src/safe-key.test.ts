import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSafeKey, resolveObjectPath, StorageKeyError } from './safe-key';

describe('assertSafeKey', () => {
  it('accepts the documented key layout and returns the key unchanged', () => {
    for (const key of [
      'tracks/user-1/track-9/original.mp3',
      'covers/focus-blue-001.webp',
      'covers/uploaded/user-1/cover-2.png',
      'exports/user-1/bundle-3.zip',
      'imports/user-1/batch-4.json',
    ]) {
      expect(assertSafeKey(key)).toBe(key);
    }
  });

  it.each([
    ['empty', ''],
    ['absolute', '/etc/passwd'],
    ['parent traversal', '../secret'],
    ['embedded traversal', 'tracks/../../etc/passwd'],
    ['trailing parent', 'tracks/..'],
    ['bare dot-dot', '..'],
    ['backslash traversal', 'tracks\\..\\secret'],
    ['null byte', 'tracks/a\0b'],
    ['home expansion', '~/secret'],
    ['windows drive', 'C:\\windows'],
    ['double slash', 'tracks//original.mp3'],
    ['dot segment', 'tracks/./original.mp3'],
    ['trailing slash', 'tracks/'],
  ])('rejects %s', (_label, key) => {
    expect(() => assertSafeKey(key)).toThrow(StorageKeyError);
  });
});

describe('resolveObjectPath', () => {
  it('resolves a safe key to an absolute path confined to the data root', () => {
    const root = '/data';
    const abs = resolveObjectPath(root, 'tracks/user-1/track-9/original.mp3');
    expect(path.isAbsolute(abs)).toBe(true);
    expect(abs).toBe(path.join(root, 'tracks/user-1/track-9/original.mp3'));
    // The resolved path never escapes the root.
    expect(path.relative(root, abs).startsWith('..')).toBe(false);
  });

  it('rejects a traversal key before it can escape the root', () => {
    expect(() => resolveObjectPath('/data', '../../etc/passwd')).toThrow(StorageKeyError);
  });
});
