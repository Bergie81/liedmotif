import { describe, expect, it } from 'vitest';
import type { ActiveSessionOverview, SessionListItem, SessionSummary } from '@liedmotif/shared';
import {
  deriveSessionsListView,
  formatGenreTag,
  formatSessionLastActive,
  formatSessionTrackLine,
  formatTrackCount,
} from './session-list-model';

describe('formatSessionTrackLine', () => {
  it.each<[number, number, string]>([
    [4, 780, '4 Tracks · 13 min'],
    [1, 200, '1 Track · 3 min'],
    [20, 3900, '20 Tracks · 1 hr 5 min'],
    [14, 7200, '14 Tracks · 2 hr'],
    [1, 20, '1 Track · 1 min'],
  ])('puts the total after the count: %i Tracks, %s seconds', (count, seconds, expected) => {
    expect(formatSessionTrackLine(count, seconds)).toBe(expected);
  });

  it('shows only the count while no Track’s length is known', () => {
    expect(formatSessionTrackLine(4, 0)).toBe('4 Tracks');
  });

  it('shows no length for a Session with no Tracks', () => {
    expect(formatSessionTrackLine(0, 0)).toBe('No Tracks yet');
  });
});

describe('Session list model', () => {
  it('formats activity against a stable clock', () => {
    const now = Date.parse('2026-07-16T12:00:00.000Z');
    expect(formatSessionLastActive('2026-07-16T11:59:45.000Z', now)).toBe('just now');
    expect(formatSessionLastActive('2026-07-16T10:00:00.000Z', now)).toBe('2 hr ago');
    expect(formatSessionLastActive('2026-07-14T12:00:00.000Z', now)).toBe('2 days ago');
    expect(formatSessionLastActive('not-a-date', now)).toBe('recently');
  });

  it('formats Track activity for Session cards', () => {
    expect(formatTrackCount(0)).toBe('No Tracks yet');
    expect(formatTrackCount(1)).toBe('1 Track');
    expect(formatTrackCount(12)).toBe('12 Tracks');
    expect(formatGenreTag('drum-and-bass')).toBe('Drum & Bass');
    expect(formatGenreTag('lofi')).toBe('Lo-fi');
  });
});

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    status: 'active',
    title: `Session ${id}`,
    generationStatus: 'ok',
    generationStatusScope: null,
    sessionMode: 'keep_going',
    coverImageId: null,
    statusMessageSafe: null,
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:00:00.000Z',
    ...overrides,
  };
}

function listItem(id: string, overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id,
    title: `Session ${id}`,
    coverImageId: null,
    lastActiveAt: '2026-07-18T10:00:00.000Z',
    status: 'stopped',
    trackCount: 4,
    totalDurationSeconds: 240,
    genreTags: ['lofi'],
    pinned: false,
    ...overrides,
  };
}

const serverActive: ActiveSessionOverview = {
  ...summary('srv'),
  trackCount: 7,
  totalDurationSeconds: 420,
  genreTags: ['deep-house'],
};

describe('deriveSessionsListView', () => {
  it('shows the server-known active Session and keeps it out of History', () => {
    const view = deriveSessionsListView({
      serverActive,
      liveSession: null,
      liveCoverImageId: null,
      liveSessionStatus: 'active',
      items: [listItem('srv'), listItem('b')],
      pinned: [],
    });
    expect(view.active).toEqual(serverActive);
    expect(view.earlier).toEqual([listItem('b')]);
  });

  it('lets the live controller outrank a stale server view, reusing the History entry activity', () => {
    const live = summary('live', { title: 'Live one' });
    const view = deriveSessionsListView({
      serverActive: null,
      liveSession: live,
      liveCoverImageId: null,
      liveSessionStatus: 'active',
      items: [
        listItem('live', { trackCount: 9, totalDurationSeconds: 900, genreTags: ['dream-pop'] }),
        listItem('b'),
      ],
      pinned: [],
    });
    expect(view.active).toEqual({
      ...live,
      trackCount: 9,
      totalDurationSeconds: 900,
      genreTags: ['dream-pop'],
    });
    expect(view.earlier).toEqual([listItem('b')]);
  });

  it('moves a live pinned Session out of Pinned, keeping its Pinned entry activity', () => {
    const live = summary('live');
    const view = deriveSessionsListView({
      serverActive: null,
      liveSession: live,
      liveCoverImageId: null,
      liveSessionStatus: 'active',
      items: [listItem('b')],
      pinned: [listItem('live', { trackCount: 5, pinned: true }), listItem('p', { pinned: true })],
    });
    expect(view.active).toEqual({
      ...live,
      trackCount: 5,
      totalDurationSeconds: 240,
      genreTags: ['lofi'],
    });
    expect(view.pinned).toEqual([listItem('p', { pinned: true })]);
    expect(view.earlier).toEqual([listItem('b')]);
  });

  it('gives Active now to the server-known Session when the live one is reported stopped', () => {
    const stopped = summary('live', { status: 'active' });
    const view = deriveSessionsListView({
      serverActive,
      liveSession: stopped,
      liveCoverImageId: 'live-cover',
      liveSessionStatus: 'stopped',
      items: [listItem('live'), listItem('srv'), listItem('b')],
      pinned: [listItem('p', { pinned: true })],
    });
    expect(view.active).toEqual(serverActive);
    expect(view.earlier).toEqual([listItem('live'), listItem('b')]);
    expect(view.pinned).toEqual([listItem('p', { pinned: true })]);
  });

  it('leaves Active now empty when the live Session is stopped and the server knows no Active one', () => {
    const view = deriveSessionsListView({
      serverActive: null,
      liveSession: summary('live', { status: 'active' }),
      liveCoverImageId: null,
      liveSessionStatus: 'stopped',
      items: [listItem('live'), listItem('b')],
      pinned: [listItem('pinned-live', { pinned: true })],
    });
    expect(view.active).toBeNull();
    expect(view.earlier).toEqual([listItem('live'), listItem('b')]);
  });

  it('keeps a stopped live Session out of Active now even while a stale server view still names it', () => {
    const view = deriveSessionsListView({
      serverActive: { ...serverActive, id: 'live' },
      liveSession: summary('live'),
      liveCoverImageId: null,
      liveSessionStatus: 'stopped',
      items: [listItem('live')],
      pinned: [],
    });
    expect(view.active).toBeNull();
    expect(view.earlier).toEqual([listItem('live')]);
    expect(view.liveSessionKnown).toBe(true);
  });

  it('does not know a stopped live Session that only a stale server view still names', () => {
    const view = deriveSessionsListView({
      serverActive: { ...serverActive, id: 'live' },
      liveSession: summary('live'),
      liveCoverImageId: null,
      liveSessionStatus: 'stopped',
      items: [listItem('b')],
      pinned: [],
    });
    expect(view.liveSessionKnown).toBe(false);
  });

  it('pairs the fresher live summary with the server activity when both name the same Session', () => {
    const live = summary('srv', { title: 'Fresher title' });
    const view = deriveSessionsListView({
      serverActive,
      liveSession: live,
      liveCoverImageId: null,
      liveSessionStatus: 'active',
      items: [],
      pinned: [],
    });
    expect(view.active).toEqual({
      ...live,
      trackCount: 7,
      totalDurationSeconds: 420,
      genreTags: ['deep-house'],
    });
    expect(view.earlier).toEqual([]);
  });

  it('takes the active cover from the live controller — the engage-time summary goes stale', () => {
    const live = summary('srv', { coverImageId: 'placeholder-cover' });
    const view = deriveSessionsListView({
      serverActive,
      liveSession: live,
      liveCoverImageId: 'generated-cover',
      liveSessionStatus: 'active',
      items: [],
      pinned: [],
    });
    expect(view.active?.coverImageId).toBe('generated-cover');
  });

  it('keeps the live summary cover when the controller has not published one', () => {
    const live = summary('srv', { coverImageId: 'summary-cover' });
    const view = deriveSessionsListView({
      serverActive,
      liveSession: live,
      liveCoverImageId: null,
      liveSessionStatus: 'active',
      items: [],
      pinned: [],
    });
    expect(view.active?.coverImageId).toBe('summary-cover');
  });

  it('ignores a live controller cover when the server names the active Session', () => {
    const view = deriveSessionsListView({
      serverActive: { ...serverActive, coverImageId: 'server-cover' },
      liveSession: null,
      liveCoverImageId: 'left-over',
      liveSessionStatus: 'active',
      items: [],
      pinned: [],
    });
    expect(view.active?.coverImageId).toBe('server-cover');
  });

  it('passes through when nothing is active, including unloaded items', () => {
    const items = [listItem('a')];
    expect(
      deriveSessionsListView({
        serverActive: null,
        liveSession: null,
        liveCoverImageId: null,
        liveSessionStatus: 'active',
        items,
        pinned: [],
      }),
    ).toEqual({
      active: null,
      pinned: [],
      earlier: items,
      liveSessionKnown: true,
    });
    expect(
      deriveSessionsListView({
        serverActive: null,
        liveSession: summary('live'),
        liveCoverImageId: null,
        liveSessionStatus: 'active',
        items: null,
        pinned: [],
      }),
    ).toEqual({
      active: { ...summary('live'), trackCount: 0, totalDurationSeconds: 0, genreTags: [] },
      pinned: [],
      earlier: null,
      liveSessionKnown: false,
    });
  });
});
