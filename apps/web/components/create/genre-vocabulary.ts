/** The genre vocabulary from the draft home design, keyed by id — the id is the
 * match key the rest of Liedmotif scores on (the library stand-in), so
 * chips carry ids and labels are display-only.
 *
 * A family is how the sheet is BROWSED, not which genres may be combined:
 * `acoustic` and `metal` share one while `disco` and `house` do not. The sheet
 * renders families in array order, which is kept alphabetical by name. */
import { MAX_GENRE_PICKS } from '@liedmotif/shared';

export interface GenreOption {
  id: string;
  label: string;
}

export interface GenreFamily {
  name: string;
  genres: readonly GenreOption[];
}

export const GENRE_FAMILIES: readonly GenreFamily[] = [
  {
    name: 'Acoustic, rock & pop',
    genres: [
      { id: 'acoustic', label: 'Acoustic' },
      { id: 'folk', label: 'Folk' },
      { id: 'country', label: 'Country' },
      { id: 'singer-songwriter', label: 'Singer-songwriter' },
      { id: 'indie', label: 'Indie' },
      { id: 'rock', label: 'Rock' },
      { id: 'metal', label: 'Metal' },
      { id: 'pop', label: 'Pop' },
    ],
  },
  {
    name: 'Ambient',
    genres: [
      { id: 'ambient', label: 'Ambient' },
      { id: 'drone', label: 'Drone' },
      { id: 'new-age', label: 'New Age' },
      { id: 'soundscape', label: 'Soundscape' },
    ],
  },
  {
    name: 'Chill & beats',
    genres: [
      { id: 'lofi', label: 'Lo-fi' },
      { id: 'chillhop', label: 'Chillhop' },
      { id: 'trip-hop', label: 'Trip-hop' },
      { id: 'downtempo', label: 'Downtempo' },
      { id: 'hip-hop', label: 'Hip-hop' },
      { id: 'trap', label: 'Trap' },
      { id: 'phonk', label: 'Phonk' },
    ],
  },
  {
    name: 'Electronic & dance',
    genres: [
      { id: 'house', label: 'House' },
      { id: 'deep-house', label: 'Deep House' },
      { id: 'disco', label: 'Disco' },
      { id: 'techno', label: 'Techno' },
      { id: 'trance', label: 'Trance' },
      { id: 'drum-and-bass', label: 'Drum & Bass' },
      { id: 'synthwave', label: 'Synthwave' },
    ],
  },
  {
    name: 'Jazz & soul',
    genres: [
      { id: 'jazz', label: 'Jazz' },
      { id: 'soul', label: 'Soul' },
      { id: 'rnb', label: 'R&B' },
      { id: 'blues', label: 'Blues' },
      { id: 'funk', label: 'Funk' },
      { id: 'lounge', label: 'Lounge' },
    ],
  },
  {
    name: 'Orchestral & cinematic',
    genres: [
      { id: 'classical', label: 'Classical' },
      { id: 'neoclassical', label: 'Neoclassical' },
      { id: 'orchestral', label: 'Orchestral' },
      { id: 'cinematic', label: 'Cinematic' },
      { id: 'piano', label: 'Piano' },
    ],
  },
  {
    name: 'World & Latin',
    genres: [
      { id: 'bossa-nova', label: 'Bossa Nova' },
      { id: 'reggae', label: 'Reggae' },
      { id: 'afrobeats', label: 'Afrobeats' },
      { id: 'reggaeton', label: 'Reggaeton' },
    ],
  },
];

const GENRES_BY_ID = new Map<string, GenreOption>(
  GENRE_FAMILIES.flatMap((family) => family.genres.map((genre) => [genre.id, genre])),
);

/** Every pickable genre id — the vocabulary the For you ranking is scoped to. */
export const GENRE_IDS: readonly string[] = [...GENRES_BY_ID.keys()];

/** Genres blend, so picks stay bounded (the contract's cap on a free-text
 * intent's explicit picks): up to three, and the first one leads. */
export const MAX_GENRES = MAX_GENRE_PICKS;

export const GENRE_SHORTLIST_SIZE = 16;

/** The curated shortlist offered when learned taste is off or too thin to fill
 * the row — a neutral spread across every family in the vocabulary, never
 * another User's history. */
export const DEFAULT_GENRE_SHORTLIST: readonly string[] = [
  'ambient',
  'house',
  'lofi',
  'techno',
  'drum-and-bass',
  'jazz',
  'acoustic',
  'chillhop',
  'synthwave',
  'indie',
  'pop',
  'hip-hop',
  'funk',
  'classical',
  'piano',
  'bossa-nova',
];

export function genreLabel(id: string): string {
  return GENRES_BY_ID.get(id)?.label ?? id;
}

/** The row is a shortlist: what you picked first, then the User's For you
 * genres (learned taste, ranked), topped up from the default spread — every
 * pick stays visible even when picks alone fill the row. Learned tags come from
 * LLM-derived styles too, so anything outside the vocabulary is skipped rather
 * than rendered as an unlabeled chip. */
export function buildGenreShortlist(
  selected: readonly string[],
  forYouGenres: readonly string[] = [],
): string[] {
  const row = [...selected];
  const size = Math.max(GENRE_SHORTLIST_SIZE, selected.length);
  for (const id of [
    ...forYouGenres.filter((tag) => GENRES_BY_ID.has(tag)),
    ...DEFAULT_GENRE_SHORTLIST,
  ]) {
    if (row.length >= size) break;
    if (!row.includes(id)) row.push(id);
  }
  return row;
}

/** Toggle a pick, holding the cap: a pick past `MAX_GENRES` is refused. */
export function toggleGenre(selected: readonly string[], id: string): string[] {
  if (selected.includes(id)) return selected.filter((value) => value !== id);
  if (selected.length >= MAX_GENRES) return [...selected];
  return [...selected, id];
}
