// @vitest-environment jsdom

// The sign on a Playlist or Session promises it will play without a connection,
// so a partial copy must not earn it: a listener could leave home with half a
// Playlist thinking they hold it all.

import { createElement as h } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OfflineMarkStatus } from '@/lib/offline/offline-sync';
import { OfflineMark } from './offline-mark';

const statuses = vi.hoisted(() => ({ current: new Map<string, OfflineMarkStatus>() }));

vi.mock('@/lib/offline/device-offline', () => ({
  subscribeOfflineStatus: () => () => undefined,
  offlineStatusSnapshot: () => statuses.current,
}));

afterEach(() => {
  cleanup();
  statuses.current = new Map();
});

describe('OfflineMark', () => {
  it('shows once the device holds every Track of the marked Playlist', () => {
    statuses.current = new Map([['playlist:p1', { state: 'ready', total: 30 }]]);
    render(h(OfflineMark, { kind: 'playlist', id: 'p1' }));
    expect(screen.getByRole('img', { name: 'Available Offline' })).toBeTruthy();
  });

  it('follows the same rule for a Session', () => {
    statuses.current = new Map([['session:s1', { state: 'ready', total: 4 }]]);
    render(h(OfflineMark, { kind: 'session', id: 's1' }));
    expect(screen.getByRole('img', { name: 'Available Offline' })).toBeTruthy();
  });

  it.each<[string, OfflineMarkStatus]>([
    ['still downloading', { state: 'downloading', done: 12, total: 30 }],
    ['paused partway', { state: 'paused', done: 12, total: 30 }],
    ['refused for space', { state: 'refused', neededBytes: 100, freeBytes: 10 }],
  ])('stays away while the copy is %s', (_label, status) => {
    statuses.current = new Map([['playlist:p1', status]]);
    render(h(OfflineMark, { kind: 'playlist', id: 'p1' }));
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('stays away from what is not marked, even when something else is ready', () => {
    statuses.current = new Map([['playlist:other', { state: 'ready', total: 2 }]]);
    render(h(OfflineMark, { kind: 'playlist', id: 'p1' }));
    expect(screen.queryByRole('img')).toBeNull();
  });
});
