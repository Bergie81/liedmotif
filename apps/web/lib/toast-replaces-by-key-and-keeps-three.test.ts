// The toast store behind every `toast.*` call: one visible toast per key, at
// most three at once, and a dismiss that closes by key.

import { afterEach, describe, expect, it } from 'vitest';
import { shownToasts, toast } from './toast';

afterEach(() => toast.dismiss());

function messages() {
  return shownToasts().map((shown) => shown.message);
}

describe('toast store', () => {
  it('records the tone, message, title and link a caller shows', () => {
    toast.warning('Cover saved, but the old file could not be removed.', {
      title: 'Saved with a note',
      link: { label: 'Cost settings', href: '/settings/costs' },
    });

    expect(shownToasts()).toEqual([
      expect.objectContaining({
        tone: 'warning',
        message: 'Cover saved, but the old file could not be removed.',
        title: 'Saved with a note',
        link: { label: 'Cost settings', href: '/settings/costs' },
      }),
    ]);
  });

  it('replaces a visible toast that has the same key', () => {
    toast.error('Delete failed: Offline.', { key: 'playlist-delete' });
    toast.error('Delete failed: Not found.', { key: 'playlist-delete' });

    expect(messages()).toEqual(['Delete failed: Not found.']);
  });

  it('shows the same failure twice only once', () => {
    toast.error('Remove failed: Offline.');
    toast.error('Remove failed: Offline.');

    expect(messages()).toEqual(['Remove failed: Offline.']);
  });

  it('keeps the same message in different tones apart', () => {
    toast.info('Done.');
    toast.success('Done.');

    expect(shownToasts().map((shown) => shown.tone)).toEqual(['info', 'success']);
  });

  it('closes the toast whose key is dismissed and leaves the others', () => {
    toast.error('Couldn’t pin the playlist: Offline.', { key: 'playlist-pin' });
    toast.success('Profile saved.');

    toast.dismiss('playlist-pin');

    expect(messages()).toEqual(['Profile saved.']);
  });

  it('pushes the oldest out when a fourth toast arrives', () => {
    toast.success('One.');
    toast.success('Two.');
    toast.success('Three.');
    toast.success('Four.');

    expect(messages()).toEqual(['Two.', 'Three.', 'Four.']);
  });

  it('closes every toast when dismissed without a key', () => {
    toast.success('One.');
    toast.error('Two.');

    toast.dismiss();

    expect(shownToasts()).toEqual([]);
  });
});
