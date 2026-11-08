import { describe, expect, it, vi } from 'vitest';
import { hasStorageHeadroom, STORAGE_HEADROOM_MARGIN_BYTES } from './headroom';

// The rule that decides whether a write may proceed. Both "no volume" cases —
// object storage, and a statfs that fails — must read as headroom: a check that
// answers "no" when it simply cannot tell would refuse every upload on S3.

describe('hasStorageHeadroom', () => {
  it('allows a write that leaves the reserved tail intact', async () => {
    const storage = { freeBytes: async () => STORAGE_HEADROOM_MARGIN_BYTES + 1000 };
    expect(await hasStorageHeadroom(storage, 1000)).toBe(true);
  });

  it('refuses a write that would eat into the reserved tail', async () => {
    const storage = { freeBytes: async () => STORAGE_HEADROOM_MARGIN_BYTES + 999 };
    expect(await hasStorageHeadroom(storage, 1000)).toBe(false);
  });

  it('has headroom when the provider reports no free space at all', async () => {
    expect(await hasStorageHeadroom({}, 1_000_000)).toBe(true);
  });

  it('has headroom when the free-space probe itself fails', async () => {
    const storage = { freeBytes: vi.fn(async () => Promise.reject(new Error('EIO'))) };
    expect(await hasStorageHeadroom(storage, 1000)).toBe(true);
  });
});
