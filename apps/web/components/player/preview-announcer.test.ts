// @vitest-environment jsdom

import { cleanup, renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  announceTrackPreview,
  clearTrackPreview,
  createPreviewOwner,
  useTrackPreviewAnnouncement,
  type TrackPreviewAnnouncement,
} from './preview-announcer';

function announcement(overrides: Partial<TrackPreviewAnnouncement> = {}): TrackPreviewAnnouncement {
  return {
    trackId: 'track-1',
    title: 'Rain on Tin',
    artist: 'Liedmotif',
    coverImageId: null,
    playing: true,
    toggle: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('preview announcer', () => {
  it('publishes announcements to subscribers and clears them', () => {
    const owner = createPreviewOwner();
    const { result } = renderHook(() => useTrackPreviewAnnouncement());
    expect(result.current).toBeNull();

    act(() => announceTrackPreview(owner, announcement()));
    expect(result.current?.title).toBe('Rain on Tin');
    expect(result.current?.playing).toBe(true);

    act(() => clearTrackPreview(owner));
    expect(result.current).toBeNull();
  });

  it('a stale owner cannot clear a newer announcement', () => {
    const older = createPreviewOwner();
    const newer = createPreviewOwner();
    const { result } = renderHook(() => useTrackPreviewAnnouncement());

    act(() => announceTrackPreview(older, announcement({ trackId: 'a' })));
    act(() => announceTrackPreview(newer, announcement({ trackId: 'b' })));
    act(() => clearTrackPreview(older));
    expect(result.current?.trackId).toBe('b');

    act(() => clearTrackPreview(newer));
    expect(result.current).toBeNull();
  });
});
