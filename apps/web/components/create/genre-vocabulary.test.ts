import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GENRE_SHORTLIST,
  GENRE_FAMILIES,
  GENRE_SHORTLIST_SIZE,
  MAX_GENRES,
  buildGenreShortlist,
  genreLabel,
  toggleGenre,
} from './genre-vocabulary';

describe('genre vocabulary', () => {
  it('keys every genre by a unique id and resolves labels from ids', () => {
    const ids = GENRE_FAMILIES.flatMap((family) => family.genres.map((genre) => genre.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(genreLabel('drum-and-bass')).toBe('Drum & Bass');
    expect(genreLabel('lofi')).toBe('Lo-fi');
  });

  it('browses the vocabulary as record-shop families, alphabetically', () => {
    const names = GENRE_FAMILIES.map((family) => family.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
    expect(names[0]).toBe('Acoustic, Rock & Pop');
    expect(names).toHaveLength(7);
  });
});

describe('buildGenreShortlist', () => {
  it('offers the account shortlist when nothing is picked', () => {
    expect(buildGenreShortlist([])).toEqual(DEFAULT_GENRE_SHORTLIST);
    expect(DEFAULT_GENRE_SHORTLIST).toHaveLength(GENRE_SHORTLIST_SIZE);
    expect(new Set(DEFAULT_GENRE_SHORTLIST).size).toBe(GENRE_SHORTLIST_SIZE);
  });

  it('leads with the picks in pick order and fills the rest without duplicates', () => {
    const row = buildGenreShortlist(['disco', 'techno']);
    expect(row.slice(0, 2)).toEqual(['disco', 'techno']);
    expect(row).toHaveLength(GENRE_SHORTLIST_SIZE);
    expect(new Set(row).size).toBe(row.length);
  });

  it('fills from the account top genres first, topping up from the default shortlist', () => {
    const row = buildGenreShortlist([], ['jazz', 'soul', 'funk']);
    expect(row.slice(0, 3)).toEqual(['jazz', 'soul', 'funk']);
    expect(row).toHaveLength(GENRE_SHORTLIST_SIZE);
    expect(new Set(row).size).toBe(row.length);
  });

  it('ignores history tags outside the vocabulary', () => {
    const row = buildGenreShortlist([], ['melodic techno', 'jazz', '']);
    expect(row[0]).toBe('jazz');
    expect(row).not.toContain('melodic techno');
    expect(row).not.toContain('');
    expect(row).toHaveLength(GENRE_SHORTLIST_SIZE);
  });

  it('leads with the picks and dedupes them out of the personal fill', () => {
    const row = buildGenreShortlist(['disco'], ['jazz', 'disco', 'soul']);
    expect(row.slice(0, 3)).toEqual(['disco', 'jazz', 'soul']);
    expect(row).toHaveLength(GENRE_SHORTLIST_SIZE);
    expect(new Set(row).size).toBe(row.length);
  });
});

describe('toggleGenre', () => {
  it('adds a genre in pick order up to the cap', () => {
    expect(toggleGenre([], 'house')).toEqual(['house']);
    expect(toggleGenre(['house'], 'disco')).toEqual(['house', 'disco']);
  });

  it('refuses a pick past the cap', () => {
    const atCap = ['house', 'disco', 'funk'];
    expect(atCap).toHaveLength(MAX_GENRES);
    expect(toggleGenre(atCap, 'jazz')).toEqual(atCap);
  });

  it('removes a picked genre and leaves the others in order', () => {
    expect(toggleGenre(['house', 'disco', 'funk'], 'disco')).toEqual(['house', 'funk']);
  });
});
