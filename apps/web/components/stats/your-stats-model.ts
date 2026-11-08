import {
  DAILY_LISTENING_LIMIT,
  LISTENING_RANGE_DAYS,
  type GenerationStatsData,
  type ListeningRange,
  type ListeningStatsData,
} from '@liedmotif/shared';
import { searchQueryString } from '@/components/search/search-model';

export const RANGE_LABELS: Record<ListeningRange, string> = {
  '7d': '7 days',
  '30d': '30 days',
  all: 'All time',
};

export function formatListeningTime(ms: number): string {
  if (ms > 0 && ms < 60_000) return '< 1 min';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** A count with the noun it takes, singular or plural. */
export const counted = (count: number, one: string, many: string) =>
  `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

/** Where a range opens, on the calendar of `timezone`. */
export function rangeOpening(period: { from: string | null; timezone: string }): string {
  if (period.from === null) return 'All time';
  const from = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: period.timezone,
  }).format(new Date(period.from));
  return `Since ${from}`;
}

/**
 * The calendar every listening figure is cut by: where the range opens, or the
 * record if that began later, and in which timezone.
 */
export function periodLabel(stats: ListeningStatsData): string {
  const opening = stats.rangePredatesCollection
    ? { from: stats.collectionStartedAt, timezone: stats.timezone }
    : stats;
  return `${rangeOpening(opening)} · ${stats.timezone}`;
}

/**
 * What the figures can and cannot claim. Listening before collection began was
 * never recorded, so any view that reaches back that far — all time always
 * does — says so rather than letting the gap read as silence.
 */
export function coverageNote(stats: ListeningStatsData): string {
  const since = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: stats.timezone,
  }).format(new Date(stats.collectionStartedAt));
  const incomplete = stats.range === 'all' || stats.rangePredatesCollection;
  const covered = `Your own Tracks in Sessions, Playlists and previews, recorded since ${since}.`;
  return incomplete
    ? `${covered} Earlier listening is not on record, so it is missing here — not zero.`
    : covered;
}

export interface GenreRow {
  key: string;
  label: string;
  time: string;
  /** Percent of all credited listening in the range. */
  share: number;
}

/** Most listened genres; time on Tracks without genre tags reads as Unclassified. */
export function genreRows(stats: ListeningStatsData): GenreRow[] {
  return stats.topGenres.map((entry) => ({
    key: entry.genre ?? '',
    label: entry.genre ?? 'Unclassified',
    time: formatListeningTime(entry.listenedMs),
    share: stats.listenedMs > 0 ? Math.round((entry.listenedMs / stats.listenedMs) * 100) : 0,
  }));
}

export interface TrackRow {
  key: string;
  label: string;
  coverImageId: string | null;
  plays: string;
  /** Percent of all qualifying plays in the range. */
  share: number;
  /**
   * What a tap does: play the Track in the Session it came from, open the
   * owner-scoped Track search when that Session is gone, or nothing for a
   * deleted Track.
   */
  action:
    | { kind: 'play'; track: { id: string; originSessionId: string } }
    | { kind: 'open'; href: string }
    | null;
}

function trackAction(entry: ListeningStatsData['topTracks'][number]): TrackRow['action'] {
  if (entry.trackId === null) return null;
  if (entry.originSessionId !== null) {
    return { kind: 'play', track: { id: entry.trackId, originSessionId: entry.originSessionId } };
  }
  if (!entry.title) return null;
  const query = { query: entry.title, scope: 'tracks', sort: 'relevance', lyrics: false } as const;
  return { kind: 'open', href: `/search?${searchQueryString(query)}` };
}

export function trackRows(stats: ListeningStatsData): TrackRow[] {
  return stats.topTracks.map((entry, index) => ({
    key: entry.trackId ?? `deleted-${index}`,
    label: entry.trackId === null ? 'Deleted track' : (entry.title ?? 'Untitled track'),
    coverImageId: entry.coverImageId,
    plays: counted(entry.plays, 'play', 'plays'),
    share: stats.qualifyingPlays > 0 ? Math.round((entry.plays / stats.qualifyingPlays) * 100) : 0,
    action: trackAction(entry),
  }));
}

export interface GenerationSummary {
  /** Nothing was generated and nothing failed in the period. */
  empty: boolean;
  notes: string[];
}

/**
 * The limits of the generation figures, stated only when they apply. Output
 * generated before the listening record begins cannot be called never heard, and
 * Tracks reconstructed from before the output record make a count incomplete.
 */
export function generationSummary(stats: ListeningStatsData): GenerationSummary {
  const g = stats.generation;
  const notes: string[] = [];
  if (g.unknownCoverageTracks > 0) {
    notes.push(
      `${counted(g.unknownCoverageTracks, 'track was', 'tracks were')} generated before your listening record begins, so whether you heard ${g.unknownCoverageTracks === 1 ? 'it' : 'them'} is unknown — left out of Never heard.`,
    );
  }
  if (g.historicalTracks > 0) {
    notes.push(
      `${counted(g.historicalTracks, 'track survives', 'tracks survive')} from before generated tracks were recorded. Tracks deleted back then are missing, so this is incomplete historical output — not a lifetime total.`,
    );
  }
  if (g.storageFailures > 0) {
    notes.push(
      `${counted(g.storageFailures, 'generated track', 'generated tracks')} could not be stored after first playing. That is a storage failure, not a failed attempt, and still counts as generated.`,
    );
  }
  if (g.failedAttempts > 0) {
    notes.push(
      'A failed attempt is one music-model call that ended without a result — not a number of tracks.',
    );
  }
  return {
    empty: g.generatedTracks === 0 && g.failedAttempts === 0,
    notes,
  };
}

export interface DailyPoint {
  /** `YYYY-MM-DD` on the reporting calendar. */
  day: string;
  label: string;
  listenedMs: number;
}

const DAY_MS = 86_400_000;

const dayLabel = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

/** The calendar day `at` falls on in `timezone`, as the UTC midnight carrying that date. */
function localDay(at: Date, timezone: string): number {
  // en-CA formats a date as YYYY-MM-DD.
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(at);
  return Date.parse(`${day}T00:00:00Z`);
}

/**
 * One point per calendar day of the range, today last, so a day without
 * listening draws as a gap instead of vanishing. No range opens before the day
 * collection began, and none reaches further back than the series does.
 */
export function dailySeries(
  stats: Pick<ListeningStatsData, 'range' | 'timezone' | 'daily' | 'collectionStartedAt'>,
  now: Date,
): DailyPoint[] {
  const today = localDay(now, stats.timezone);
  const daysRecorded =
    (today - localDay(new Date(stats.collectionStartedAt), stats.timezone)) / DAY_MS + 1;
  const days = Math.min(
    stats.range === 'all' ? DAILY_LISTENING_LIMIT : LISTENING_RANGE_DAYS[stats.range],
    Math.max(1, daysRecorded),
  );
  const listened = new Map(stats.daily.map((entry) => [entry.day, entry.listenedMs]));
  return Array.from({ length: days }, (_, index) => {
    const at = new Date(today - (days - 1 - index) * DAY_MS);
    const day = at.toISOString().slice(0, 10);
    return { day, label: dayLabel.format(at), listenedMs: listened.get(day) ?? 0 };
  });
}

/** Generated Tracks by what the listening record can say about them. */
export function generationParts(g: GenerationStatsData) {
  return {
    heard: Math.max(0, g.generatedTracks - g.neverHeardTracks - g.unknownCoverageTracks),
    neverHeard: g.neverHeardTracks,
    unknown: g.unknownCoverageTracks,
  };
}

/**
 * The lamp at the strength a rank earns, the most listened brightest — as a CSS
 * color, so a canvas mark and its list swatch are the same color by construction.
 */
export function rankColor(lamp: string, rank: number, count: number): string {
  const strength = count <= 1 ? 100 : Math.round(100 - (rank / (count - 1)) * 75);
  return `color-mix(in srgb, ${lamp} ${strength}%, transparent)`;
}
