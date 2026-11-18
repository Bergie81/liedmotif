import { describe, expect, it } from 'vitest';
import { appendUniqueById } from '@/lib/append-unique';
import {
  formatLibraryTrackMetadata,
  formatTrackDuration,
  getTrackAvailability,
  trackAudioNotice,
} from './library-view-model';

const track = (id: string) => ({ id });

describe('Library view model', () => {
  it('appends cursor pages without duplicating Tracks', () => {
    expect(appendUniqueById([track('a'), track('b')], [track('b'), track('c')])).toEqual([
      track('a'),
      track('b'),
      track('c'),
    ]);
  });

  it('formats duration and distinguishes unavailable and never-played Tracks', () => {
    expect(formatTrackDuration(185)).toBe('3:05');
    expect(formatTrackDuration(null)).toBe('—:——');
    expect(getTrackAvailability({ status: 'ready', audioUrl: null, hasPlayed: false })).toEqual({
      audioNotice: 'Audio unavailable',
      hasPlayed: false,
    });
    expect(
      getTrackAvailability({ status: 'ready', audioUrl: '/api/audio/x', hasPlayed: false }),
    ).toEqual({ audioNotice: null, hasPlayed: false });
    expect(
      getTrackAvailability({ status: 'streamable', audioUrl: '/api/audio/x', hasPlayed: true }),
    ).toEqual({ audioNotice: null, hasPlayed: true });
  });

  it('marks a Track whose final never arrived as one that could not be kept', () => {
    expect(trackAudioNotice({ status: 'failed', audioUrl: null })).toBe('Could not be kept');
    // The status wins even over a stale audio path.
    expect(trackAudioNotice({ status: 'failed', audioUrl: '/api/audio/x' })).toBe(
      'Could not be kept',
    );
  });

  it('formats the metadata line as duration · Session title · genres', () => {
    const item = {
      durationSeconds: 185,
      originSessionTitle: 'Morning Focus',
      genreTags: ['ambient', 'lo-fi'],
    };
    expect(formatLibraryTrackMetadata(item)).toBe('3:05 · MORNING FOCUS · AMBIENT, LO-FI');
  });

  it('falls back to Untitled Session, caps genres at three, and drops the empty genre slot', () => {
    expect(
      formatLibraryTrackMetadata({
        durationSeconds: null,
        originSessionTitle: '  ',
        genreTags: ['a', 'b', 'c', 'd'],
      }),
    ).toBe('—:—— · UNTITLED SESSION · A, B, C');
    expect(
      formatLibraryTrackMetadata({ durationSeconds: 60, originSessionTitle: null, genreTags: [] }),
    ).toBe('1:00 · UNTITLED SESSION');
  });
});
