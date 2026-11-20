// The home headline greets the listener by name. Greetings are templates with
// a `{name}` slot rather than finished lines, because the pick happens on the
// server (once per load, so a reload re-rolls it) while the name lives in the
// client-side chrome context. Every line stays short: it lands on a display
// headline, and a phone wraps anything past about 30 characters.

/** Warm, short and music-minded: right at any hour, on any day. */
const ANY_TIME: readonly string[] = [
  'Hi, {name}!',
  'Hey, {name}!',
  'Welcome back, {name}!',
  'Good to see you, {name}!',
  'There you are, {name}.',
  'What’s the mood, {name}?',
  'Press play, {name}.',
  'Name a vibe, {name}.',
  'Turn it up, {name}.',
  'Cue it up, {name}.',
  'Set the tone, {name}.',
  'The deck is yours, {name}.',
  'Ready for a new sound, {name}?',
  'Something new, {name}?',
  'Let’s make some noise, {name}.',
  'What are we hearing, {name}?',
  'Fresh tracks await, {name}.',
  'One idea, endless music, {name}.',
  'Drop the needle, {name}.',
  'What’s the soundtrack, {name}?',
  'Hit the right note, {name}.',
  'Find your groove, {name}.',
  'Louder or softer, {name}?',
  'A song for right now, {name}?',
  'Music on your terms, {name}.',
  'What should we play, {name}?',
];

/** Dayparts by local hour, first match wins. */
const DAYPARTS: ReadonlyArray<{ from: number; to: number; greetings: readonly string[] }> = [
  {
    from: 5,
    to: 11,
    greetings: [
      'Good morning, {name}!',
      'Morning, {name}!',
      'Coffee and a soundtrack, {name}?',
      'Ease into the day, {name}.',
      'Rise and shine, {name}.',
      'Wake-up music, {name}?',
      'Start the day loud, {name}?',
    ],
  },
  {
    from: 12,
    to: 17,
    greetings: [
      'Good afternoon, {name}!',
      'Afternoon groove, {name}?',
      'Need a midday lift, {name}?',
      'Focus music, {name}?',
      'Beat the afternoon slump, {name}.',
      'Lunch break beats, {name}?',
    ],
  },
  {
    from: 18,
    to: 22,
    greetings: [
      'Good evening, {name}.',
      'Evening, {name}.',
      'Time to unwind, {name}?',
      'Dinner needs a soundtrack, {name}.',
      'Golden hour tunes, {name}?',
      'Kick back, {name}.',
      'Evening wind-down, {name}?',
    ],
  },
  {
    from: 23,
    to: 4,
    greetings: [
      'Still up, {name}?',
      'Late one, {name}?',
      'Night owl mode, {name}?',
      'Something for the quiet hours, {name}?',
      'Soft and low, {name}?',
      'Midnight mix, {name}?',
    ],
  },
];

/** By local weekday, 0 = Sunday. */
const WEEKDAYS: readonly (readonly string[])[] = [
  ['Slow Sunday, {name}?', 'Sunday sounds, {name}.'],
  ['New week, new sound, {name}.', 'Monday needs a beat, {name}.'],
  ['Tuesday tunes, {name}?'],
  ['Midweek mix, {name}?'],
  ['Almost Friday, {name}.'],
  ['It’s Friday, {name}!', 'Weekend warm-up, {name}?'],
  ['Saturday soundtrack, {name}?', 'No plans, just music, {name}?'],
];

/** By local month, 1 = January. Named for the month, not its weather, so both hemispheres read true. */
const MONTHS: readonly string[] = [
  'Fresh January sounds, {name}?',
  'February feelings, {name}?',
  'March into music, {name}.',
  'An April playlist, {name}?',
  'May vibes, {name}?',
  'June tunes, {name}?',
  'July jams, {name}?',
  'An August mix, {name}?',
  'September sounds, {name}?',
  'October moods, {name}?',
  'A November mood, {name}?',
  'December sounds, {name}?',
];

type Season = 'winter' | 'spring' | 'summer' | 'autumn';

const SEASONS: Readonly<Record<Season, readonly string[]>> = {
  winter: ['Winter warm-up, {name}?', 'Cozy winter sounds, {name}?'],
  spring: ['Spring in your step, {name}?', 'Fresh spring sounds, {name}.'],
  summer: ['Summer sounds, {name}?', 'A sunny mix, {name}?'],
  autumn: ['Autumn moods, {name}?', 'Falling-leaves mix, {name}?'],
};

/** The northern season of each month, 1 = January; the south runs six months on. */
const NORTHERN_SEASON: readonly Season[] = [
  'winter',
  'winter',
  'spring',
  'spring',
  'spring',
  'summer',
  'summer',
  'summer',
  'autumn',
  'autumn',
  'autumn',
  'winter',
];

/** Fixed-date days by `month-day`. */
const HOLIDAYS: Readonly<Record<string, readonly string[]>> = {
  '1-1': ['Happy New Year, {name}!', 'New year, new sound, {name}.'],
  '2-14': ['Love songs today, {name}?'],
  '10-31': ['Happy Halloween, {name}!', 'Something spooky, {name}?'],
  '12-24': ['A Christmas Eve mix, {name}?'],
  '12-25': ['Merry Christmas, {name}!'],
  '12-31': ['Last mix of the year, {name}?', 'Ready for midnight, {name}?'],
};

/** Days without playing their own Tracks after which Home says those Tracks missed the owner. */
const LONG_ABSENCE_DAYS = 7;
/** A week busier than this earns a mention. */
const BUSY_WEEK_TRACKS = 5;
const TRACK_MILESTONES = [10_000, 5_000, 2_500, 1_000, 500, 250, 100] as const;
/** The longest Session title that still fits the headline. */
const MAX_TITLE_LENGTH = 28;

/** How often a special day wins the pick, and then a personal line. */
const SPECIAL_SHARE = 0.5;
const PERSONAL_SHARE = 1 / 3;

/** The listener's wall clock in the Instance timezone. */
export interface LocalClock {
  year: number;
  /** 1 = January. */
  month: number;
  day: number;
  hour: number;
  /** 0 = Sunday. */
  weekday: number;
  /** Null when the zone keeps no daylight saving, which is what tells them apart. */
  hemisphere: 'north' | 'south' | null;
}

/** What Home knows about the owner's own music, each fact optional in effect. */
export interface GreetingFacts {
  lastSessionTitle: string | null;
  /** A display label, not a genre id. */
  topGenre: string | null;
  totalTracks: number;
  tracksThisWeek: number;
  /** Since the owner last played one of their own Tracks; Lounge and offline plays go unrecorded. */
  daysSinceListening: number | null;
  /** Whole years since the account was made, set only on its calendar day. */
  anniversaryYears: number | null;
}

export const NO_GREETING_FACTS: GreetingFacts = {
  lastSessionTitle: null,
  topGenre: null,
  totalTracks: 0,
  tracksThisWeek: 0,
  daysSinceListening: null,
  anniversaryYears: null,
};

export interface GreetingPools {
  /** Lines only today earns: a holiday, the anniversary, a return after a while. */
  special: string[];
  /** Lines about the owner's own music. */
  personal: string[];
  /** Everything else: the any-time lines plus the clock's daypart, weekday, month and season. */
  general: string[];
}

function daypartGreetings(hour: number): readonly string[] {
  const part = DAYPARTS.find(({ from, to }) =>
    // A window that crosses midnight covers the hours on both sides of it.
    from <= to ? hour >= from && hour <= to : hour >= from || hour <= to,
  );
  return part?.greetings ?? [];
}

function seasonGreetings(clock: LocalClock): readonly string[] {
  if (!clock.hemisphere) return [];
  const month = clock.hemisphere === 'north' ? clock.month : ((clock.month + 5) % 12) + 1;
  const season = NORTHERN_SEASON[month - 1];
  return season ? SEASONS[season] : [];
}

function personalGreetings(facts: GreetingFacts): string[] {
  const lines: string[] = [];
  const title = facts.lastSessionTitle?.trim();
  // A `{` would let the title capture the name slot.
  if (title && title.length <= MAX_TITLE_LENGTH && !title.includes('{')) {
    lines.push(`Back to “${title}”, {name}?`);
  }
  const genre = facts.topGenre?.trim();
  if (genre && !genre.includes('{')) {
    lines.push(`More ${genre} today, {name}?`, `In a ${genre} mood, {name}?`);
  }
  if (facts.tracksThisWeek >= BUSY_WEEK_TRACKS) {
    lines.push(`${facts.tracksThisWeek} new tracks this week, {name}.`);
  }
  const milestone = TRACK_MILESTONES.find((m) => facts.totalTracks >= m);
  if (milestone) lines.push(`${milestone.toLocaleString('en-US')}+ tracks made, {name}!`);
  return lines;
}

/** Every line this load could greet with, by how strongly it is meant to win. */
export function greetingPools(clock: LocalClock | null, facts: GreetingFacts): GreetingPools {
  const special: string[] = [];
  if (clock) special.push(...(HOLIDAYS[`${clock.month}-${clock.day}`] ?? []));
  if (facts.anniversaryYears) {
    special.push(
      facts.anniversaryYears === 1
        ? 'One year of music, {name}!'
        : `${facts.anniversaryYears} years of music, {name}!`,
    );
  }
  if (facts.daysSinceListening !== null && facts.daysSinceListening >= LONG_ABSENCE_DAYS) {
    special.push('Your tracks missed you, {name}.');
  }
  const general = clock
    ? [
        ...ANY_TIME,
        ...daypartGreetings(clock.hour),
        ...(WEEKDAYS[clock.weekday] ?? []),
        ...(MONTHS[clock.month - 1] ? [MONTHS[clock.month - 1]!] : []),
        ...seasonGreetings(clock),
      ]
    : [...ANY_TIME];
  return { special, personal: personalGreetings(facts), general };
}

function pickFrom(pool: readonly string[], random: () => number): string {
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!;
}

/**
 * One greeting template for this load. A special day wins half the time, then a
 * personal line a third of the time, so neither wears thin; pass a null clock
 * when the timezone read failed to draw from the clock-independent lines only.
 */
export function pickGreeting(
  clock: LocalClock | null,
  facts: GreetingFacts,
  random: () => number,
): string {
  const pools = greetingPools(clock, facts);
  if (pools.special.length && random() < SPECIAL_SHARE) return pickFrom(pools.special, random);
  if (pools.personal.length && random() < PERSONAL_SHARE) return pickFrom(pools.personal, random);
  return pickFrom(pools.general, random);
}

/** Whole years since `joined`, when `today` is its calendar day in a later year. */
export function anniversaryYears(
  joined: LocalClock | null,
  today: LocalClock | null,
): number | null {
  if (!joined || !today) return null;
  if (joined.month !== today.month || joined.day !== today.day) return null;
  const years = today.year - joined.year;
  return years > 0 ? years : null;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** The zone's UTC offset in minutes at `at`, from its `GMT+05:30`-style name. */
function offsetMinutes(at: Date, timezone: string): number {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value ?? '';
  const match = /([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

/**
 * The wall clock in `timezone`, or null when the zone is not one the runtime
 * knows — the greeting then skips every clock-bound line, which beats greeting a
 * listener good morning at midnight because a container runs on UTC. A zone that
 * springs forward in July is northern, one that does in January southern.
 */
export function localClock(now: Date, timezone: string): LocalClock | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number.parseInt(parts.find((p) => p.type === type)?.value ?? '', 10);
    const weekday = WEEKDAY_INDEX[parts.find((p) => p.type === 'weekday')?.value ?? ''];
    const clock = {
      year: part('year'),
      month: part('month'),
      day: part('day'),
      hour: part('hour'),
    };
    if (Object.values(clock).some(Number.isNaN) || weekday === undefined) return null;
    const january = offsetMinutes(new Date(Date.UTC(clock.year, 0, 15)), timezone);
    const july = offsetMinutes(new Date(Date.UTC(clock.year, 6, 15)), timezone);
    const hemisphere = july > january ? 'north' : january > july ? 'south' : null;
    return { ...clock, weekday, hemisphere };
  } catch {
    return null;
  }
}

/**
 * The finished headline: the template greeting the listener by first name —
 * what a person is called, not their full account name. A listener with no
 * usable name is greeted without one rather than by an empty slot.
 */
export function formatGreeting(template: string, name: string): string {
  const firstName = name.trim().split(/\s+/)[0];
  if (!firstName) return 'Welcome back!';
  // A replacer function, so a `$` in the name is never read as a replacement pattern.
  return template.replace('{name}', () => firstName);
}
