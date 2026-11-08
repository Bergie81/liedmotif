import { describe, expect, it } from 'vitest';
import type { ListeningStatsData } from '@liedmotif/shared';
import {
  coverageNote,
  dailySeries,
  generationParts,
  formatListeningTime,
  generationSummary,
  genreRows,
  periodLabel,
  trackRows,
} from './your-stats-model';

const base: ListeningStatsData = {
  range: '30d',
  timezone: 'Europe/Berlin',
  from: '2026-08-21T22:00:00.000Z',
  listenedMs: 0,
  qualifyingPlays: 0,
  uniqueTracks: 0,
  topTracks: [],
  topGenres: [],
  daily: [],
  collectionStartedAt: '2026-09-20T09:30:00.000Z',
  rangePredatesCollection: true,
  generation: {
    generatedTracks: 0,
    historicalTracks: 0,
    storageFailures: 0,
    failedAttempts: 0,
    neverHeardTracks: 0,
    unknownCoverageTracks: 0,
  },
};

describe('formatListeningTime', () => {
  it('reads as minutes below an hour and hours plus minutes above', () => {
    expect(formatListeningTime(0)).toBe('0 min');
    expect(formatListeningTime(59_999)).toBe('< 1 min');
    expect(formatListeningTime(47 * 60_000)).toBe('47 min');
    expect(formatListeningTime(134 * 60_000 + 40_000)).toBe('2 h 14 min');
  });
});

describe('coverageNote', () => {
  it('dates the start of collection in the reporting timezone', () => {
    // 22:30 UTC on the 19th is already the 20th in Berlin.
    expect(coverageNote({ ...base, collectionStartedAt: '2026-09-19T22:30:00.000Z' })).toContain(
      '20 September 2026',
    );
  });

  it('names every surface the figures cover', () => {
    expect(coverageNote(base)).toMatch(/Sessions, Playlists and previews/);
  });

  it('says earlier listening is unknown when the range reaches before collection', () => {
    expect(coverageNote(base)).toMatch(/earlier listening is not on record/i);
    expect(coverageNote({ ...base, rangePredatesCollection: false })).not.toMatch(/not recorded/i);
  });

  it('never calls all-time complete: it is everything since collection began', () => {
    expect(
      coverageNote({ ...base, range: 'all', from: null, rangePredatesCollection: false }),
    ).toMatch(/earlier listening is not on record/i);
  });
});

describe('genreRows', () => {
  it('labels untagged time Unclassified and sizes each genre against all listening', () => {
    expect(
      genreRows({
        ...base,
        listenedMs: 200_000,
        topGenres: [
          { genre: 'techno', listenedMs: 150_000 },
          { genre: null, listenedMs: 50_000 },
        ],
      }),
    ).toEqual([
      { key: 'techno', label: 'techno', time: '2 min', share: 75 },
      { key: '', label: 'Unclassified', time: '< 1 min', share: 25 },
    ]);
  });
});

describe('trackRows', () => {
  it('opens an available Track in the owner-scoped Track search, and leaves a deleted one unnamed and unlinked', () => {
    expect(
      trackRows({
        ...base,
        qualifyingPlays: 12,
        topTracks: [
          {
            trackId: 't1',
            title: 'Night & Day',
            coverImageId: 'c1',
            originSessionId: 's1',
            plays: 3,
          },
          { trackId: 't2', title: null, coverImageId: null, originSessionId: null, plays: 2 },
          { trackId: null, title: null, coverImageId: null, originSessionId: null, plays: 1 },
        ],
      }),
    ).toEqual([
      {
        key: 't1',
        label: 'Night & Day',
        coverImageId: 'c1',
        plays: '3 plays',
        share: 25,
        action: { kind: 'play', track: { id: 't1', originSessionId: 's1' } },
      },
      {
        key: 't2',
        label: 'Untitled track',
        coverImageId: null,
        plays: '2 plays',
        share: 17,
        action: null,
      },
      {
        key: 'deleted-2',
        label: 'Deleted track',
        coverImageId: null,
        plays: '1 play',
        share: 8,
        action: null,
      },
    ]);
  });

  it('opens the owner-scoped Track search for a Track whose Session is gone', () => {
    const [row] = trackRows({
      ...base,
      topTracks: [
        {
          trackId: 't1',
          title: 'Night & Day',
          coverImageId: null,
          originSessionId: null,
          plays: 1,
        },
      ],
    });
    expect(row?.action).toEqual({ kind: 'open', href: '/search?q=Night+%26+Day&scope=tracks' });
  });
});

describe('periodLabel', () => {
  it('names the local day the range opens on, and the timezone that decides it', () => {
    // 22:00 UTC on the 21st is midnight on the 22nd in Berlin.
    const covered = { ...base, collectionStartedAt: '2026-01-01T00:00:00.000Z' };
    expect(periodLabel({ ...covered, rangePredatesCollection: false })).toBe(
      'Since 22 Aug 2026 · Europe/Berlin',
    );
    expect(periodLabel({ ...base, range: 'all', from: null, rangePredatesCollection: false })).toBe(
      'All time · Europe/Berlin',
    );
  });

  it('opens on the day the record began when the range reaches further back', () => {
    expect(periodLabel(base)).toBe('Since 20 Sept 2026 · Europe/Berlin');
  });
});

describe('generationSummary', () => {
  const generation = (over: Partial<ListeningStatsData['generation']>) =>
    generationSummary({ ...base, generation: { ...base.generation, ...over } });

  it('says nothing was recorded rather than showing a run of zeros', () => {
    expect(generation({})).toEqual({ empty: true, notes: [] });
  });

  it('says which output is left out of never heard because listening was not yet recorded', () => {
    const partial = generation({
      generatedTracks: 6,
      neverHeardTracks: 2,
      unknownCoverageTracks: 3,
    });
    expect(partial.notes.join(' ')).toContain(
      '3 tracks were generated before your listening record',
    );
  });

  it('labels surviving legacy Tracks as incomplete historical output', () => {
    const notes = generation({ generatedTracks: 9, historicalTracks: 1 }).notes.join(' ');
    expect(notes).toContain('1 track survives from before');
    expect(notes).toContain('incomplete historical output');
  });

  it('keeps a storage failure apart from a failed attempt, and an attempt apart from Tracks', () => {
    const notes = generation({ generatedTracks: 2, storageFailures: 1, failedAttempts: 2 }).notes;
    expect(notes.join(' ')).toContain('1 generated track could not be stored');
    expect(notes.join(' ')).toContain('one music-model call');
    expect(generation({ generatedTracks: 2 }).notes).toEqual([]);
  });
});

describe('dailySeries', () => {
  const now = new Date('2026-09-20T21:30:00.000Z');

  it('fills every day of the range up to the local today, silent days as zero', () => {
    const series = dailySeries(
      {
        ...base,
        range: '7d',
        collectionStartedAt: '2026-01-01T00:00:00.000Z',
        daily: [{ day: '2026-09-18', listenedMs: 120_000 }],
      },
      now,
    );
    // 23:30 in Berlin is still the 20th.
    expect(series.map((point) => point.day)).toEqual([
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
    ]);
    expect(series[4]).toEqual({ day: '2026-09-18', label: '18 Sept', listenedMs: 120_000 });
    expect(series[6]?.listenedMs).toBe(0);
  });

  it('follows the local calendar past midnight', () => {
    const series = dailySeries({ ...base, range: '7d' }, new Date('2026-09-20T22:30:00.000Z'));
    expect(series.at(-1)?.day).toBe('2026-09-21');
  });

  it('draws no days from before the record began', () => {
    const series = dailySeries(
      { ...base, range: '30d', collectionStartedAt: '2026-09-18T09:30:00.000Z' },
      now,
    );
    expect(series.map((point) => point.day)).toEqual(['2026-09-18', '2026-09-19', '2026-09-20']);
  });

  it('opens all time on the day collection began, never further back than the daily limit', () => {
    const recent = dailySeries(
      { ...base, range: 'all', collectionStartedAt: '2026-09-18T09:30:00.000Z' },
      now,
    );
    expect(recent.map((point) => point.day)).toEqual(['2026-09-18', '2026-09-19', '2026-09-20']);

    const old = dailySeries(
      { ...base, range: 'all', collectionStartedAt: '2025-01-01T00:00:00.000Z' },
      now,
    );
    expect(old).toHaveLength(90);
    expect(old[0]?.day).toBe('2026-06-23');
  });
});

describe('generationParts', () => {
  it('splits generated tracks into heard, never heard and unknown', () => {
    expect(
      generationParts({
        ...base.generation,
        generatedTracks: 20,
        neverHeardTracks: 6,
        unknownCoverageTracks: 4,
      }),
    ).toEqual({ heard: 10, neverHeard: 6, unknown: 4 });
  });
});
