// @vitest-environment jsdom

// A change to this device's offline storage that could not be made is
// reported as a toast; the meter and the list keep describing what is stored.

import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';

const GIB = 1024 ** 3;

const device = vi.hoisted(() => ({
  offline: null as unknown,
  statuses: new Map(),
}));
vi.mock('@/lib/offline/offline-support', () => ({ offlineSupported: () => true }));
vi.mock('@/lib/offline/device-offline', () => ({
  deviceOffline: async () => device.offline,
  offlineStatusSnapshot: () => device.statuses,
  subscribeOfflineStatus: () => () => {},
}));

const { DeviceStorageSection } = await import('./device-storage-section');

let usedBytes = 0;
const setCap = vi.fn();

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  usedBytes = 0;
  setCap.mockReset();
  device.offline = {
    contents: async () => ({
      marks: [],
      copies: usedBytes > 0 ? [{ trackId: 't1', audioBytes: usedBytes, coverBytes: 0 }] : [],
      capBytes: 5 * GIB,
    }),
    setCap,
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  toast.dismiss();
});

it('reports a cap below what is stored, and clears it once the cap is set', async () => {
  usedBytes = 3 * GIB;
  setCap
    .mockResolvedValueOnce({ set: false, usedBytes: 3 * GIB })
    .mockResolvedValueOnce({ set: true });
  render(h(DeviceStorageSection, { publicUrl: 'https://music.example.test' }));
  const lower = () => screen.getByRole('button', { name: 'Lower the Cap' }) as HTMLButtonElement;

  await waitFor(() => expect(lower().disabled).toBe(false));
  fireEvent.click(lower());

  await waitFor(() =>
    expect(shownToasts()).toEqual([
      expect.objectContaining({
        tone: 'error',
        message:
          '3.0 GiB is stored on this device, more than 2.0 GiB. Remove at least 1.0 GiB of offline music below first.',
      }),
    ]),
  );

  await waitFor(() => expect(lower().disabled).toBe(false));
  fireEvent.click(lower());

  await waitFor(() => expect(shownToasts()).toEqual([]));
});

it('reports storage that could not be changed', async () => {
  setCap.mockRejectedValue(new Error('quota'));
  render(h(DeviceStorageSection, { publicUrl: 'https://music.example.test' }));
  const raise = () => screen.getByRole('button', { name: 'Raise the Cap' }) as HTMLButtonElement;

  await waitFor(() => expect(raise().disabled).toBe(false));
  fireEvent.click(raise());

  await waitFor(() =>
    expect(shownToasts()).toEqual([
      expect.objectContaining({
        tone: 'error',
        message: 'This device’s offline storage could not be changed. Try again.',
      }),
    ]),
  );
});
