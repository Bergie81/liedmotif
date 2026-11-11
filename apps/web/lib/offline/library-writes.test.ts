import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  announceLibraryWrite,
  onLibraryWrite,
  onSessionTracksLanded,
  watchSessionFinals,
} from './library-writes';

// What the offline sync follows besides app open and a regained connection:
// writes that may change an Available-offline copy, and a playing Session's
// new Tracks as their local finals land.

beforeEach(() => vi.stubGlobal('window', new EventTarget()));
afterEach(() => vi.unstubAllGlobals());

describe('library writes', () => {
  it('announces deleting, renaming or changing the cover of a Session, never the Session writes a playing tab polls', () => {
    const heard = vi.fn();
    onLibraryWrite(heard);

    announceLibraryWrite('/api/sessions/delete');
    announceLibraryWrite('/api/sessions/rename');
    announceLibraryWrite('/api/sessions/cover/select');
    announceLibraryWrite('/api/sessions/cover/upload');
    announceLibraryWrite('/api/sessions/cover/delete');
    expect(heard).toHaveBeenCalledTimes(5);

    announceLibraryWrite('/api/sessions/playback');
    announceLibraryWrite('/api/sessions/loop-lease');
    announceLibraryWrite('/api/sessions/cover/status');
    expect(heard).toHaveBeenCalledTimes(5);
  });
});

describe('watchSessionFinals', () => {
  it('announces the Session each time a Track’s local final shows up that it had not seen', () => {
    const landed = vi.fn();
    onSessionTracksLanded(landed);
    const saw = watchSessionFinals('s1');

    saw(['a', 'b']);
    saw(['a', 'b']);
    // The Queue read window moved on past 'a'; nothing new landed.
    saw(['b']);
    expect(landed.mock.calls).toEqual([['s1']]);

    saw(['b', 'c']);
    expect(landed.mock.calls).toEqual([['s1'], ['s1']]);
  });
});
