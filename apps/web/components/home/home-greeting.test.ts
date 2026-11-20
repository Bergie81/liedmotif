import { describe, expect, it } from 'vitest';
import {
  anniversaryYears,
  formatGreeting,
  greetingPools,
  localClock,
  NO_GREETING_FACTS,
  pickGreeting,
  type GreetingFacts,
  type LocalClock,
} from './home-greeting';

/** A plain Wednesday in March, northern hemisphere: no holiday, no special weekday. */
const at = (overrides: Partial<LocalClock> = {}): LocalClock => ({
  year: 2026,
  month: 3,
  day: 11,
  hour: 12,
  weekday: 3,
  hemisphere: 'north',
  ...overrides,
});

const facts = (overrides: Partial<GreetingFacts> = {}): GreetingFacts => ({
  ...NO_GREETING_FACTS,
  ...overrides,
});

const general = (clock: LocalClock | null) => greetingPools(clock, NO_GREETING_FACTS).general;

describe('greetingPools: the clock', () => {
  it('offers the time-of-day greeting for the hour and no other daypart', () => {
    const morning = general(at({ hour: 8 }));
    expect(morning).toContain('Good morning, {name}!');
    expect(morning).not.toContain('Good evening, {name}.');
    expect(morning).not.toContain('Still up, {name}?');
  });

  it('keeps the clock-independent greetings reachable at every hour', () => {
    for (const hour of [0, 5, 12, 18, 23]) expect(general(at({ hour }))).toContain('Hey, {name}!');
  });

  it('greets the small hours as late night on both sides of midnight', () => {
    expect(general(at({ hour: 23 }))).toContain('Still up, {name}?');
    expect(general(at({ hour: 2 }))).toContain('Still up, {name}?');
  });

  it('offers the weekday greetings on their day only', () => {
    expect(general(at({ weekday: 5 }))).toContain('It’s Friday, {name}!');
    expect(general(at({ weekday: 1 }))).toContain('New week, new sound, {name}.');
    expect(general(at({ weekday: 1 }))).not.toContain('It’s Friday, {name}!');
  });

  it('offers the month’s greeting', () => {
    expect(general(at({ month: 10 }))).toContain('October moods, {name}?');
    expect(general(at({ month: 3 }))).not.toContain('October moods, {name}?');
  });

  it('names the season for the hemisphere, and none when the hemisphere is unknown', () => {
    expect(general(at({ month: 12, hemisphere: 'north' }))).toContain('Winter warm-up, {name}?');
    expect(general(at({ month: 12, hemisphere: 'south' }))).toContain('Summer sounds, {name}?');
    expect(general(at({ month: 12, hemisphere: 'south' }))).not.toContain(
      'Winter warm-up, {name}?',
    );
    const unknown = general(at({ month: 12, hemisphere: null }));
    expect(unknown).not.toContain('Winter warm-up, {name}?');
    expect(unknown).not.toContain('Summer sounds, {name}?');
  });

  it('falls back to the clock-independent pool when the clock is unknown', () => {
    const unknown = greetingPools(null, NO_GREETING_FACTS);
    expect(unknown.general).toContain('Hey, {name}!');
    expect(unknown.general).not.toContain('Good morning, {name}!');
    expect(unknown.general).not.toContain('It’s Friday, {name}!');
    expect(unknown.special).toEqual([]);
  });
});

describe('greetingPools: special days', () => {
  it('marks the fixed holidays on their date only', () => {
    expect(greetingPools(at({ month: 12, day: 25 }), NO_GREETING_FACTS).special).toContain(
      'Merry Christmas, {name}!',
    );
    expect(greetingPools(at({ month: 10, day: 31 }), NO_GREETING_FACTS).special).toContain(
      'Happy Halloween, {name}!',
    );
    expect(greetingPools(at({ month: 12, day: 26 }), NO_GREETING_FACTS).special).toEqual([]);
  });

  it('celebrates the account anniversary in years', () => {
    expect(greetingPools(at(), facts({ anniversaryYears: 1 })).special).toContain(
      'One year of music, {name}!',
    );
    expect(greetingPools(at(), facts({ anniversaryYears: 3 })).special).toContain(
      '3 years of music, {name}!',
    );
  });

  it('tells an owner who has not played their own tracks for a week that they were missed', () => {
    expect(greetingPools(at(), facts({ daysSinceListening: 7 })).special).toContain(
      'Your tracks missed you, {name}.',
    );
    expect(greetingPools(at(), facts({ daysSinceListening: 6 })).special).toEqual([]);
  });
});

describe('greetingPools: personal lines', () => {
  it('invites a return to the last Session by its title', () => {
    expect(greetingPools(at(), facts({ lastSessionTitle: 'Rainy Focus' })).personal).toContain(
      'Back to “Rainy Focus”, {name}?',
    );
  });

  it('skips a title too long for the headline', () => {
    const title = 'A very long session title that would wrap';
    expect(greetingPools(at(), facts({ lastSessionTitle: title })).personal).toEqual([]);
  });

  it('offers more of the top genre', () => {
    expect(greetingPools(at(), facts({ topGenre: 'Lo-Fi' })).personal).toContain(
      'More Lo-Fi today, {name}?',
    );
  });

  it('counts a busy week, and stays quiet about a slow one', () => {
    expect(greetingPools(at(), facts({ tracksThisWeek: 12 })).personal).toContain(
      '12 new tracks this week, {name}.',
    );
    expect(greetingPools(at(), facts({ tracksThisWeek: 4 })).personal).toEqual([]);
  });

  it('marks the largest milestone reached', () => {
    expect(greetingPools(at(), facts({ totalTracks: 1234 })).personal).toContain(
      '1,000+ tracks made, {name}!',
    );
    expect(greetingPools(at(), facts({ totalTracks: 99 })).personal).toEqual([]);
  });
});

describe('greetingPools: every line', () => {
  it('has a {name} slot', () => {
    const busy = facts({
      lastSessionTitle: 'Rainy Focus',
      topGenre: 'Jazz',
      totalTracks: 600,
      tracksThisWeek: 9,
      daysSinceListening: 10,
      anniversaryYears: 2,
    });
    for (let month = 1; month <= 12; month += 1) {
      for (const day of [1, 14, 24, 25, 31]) {
        for (let hour = 0; hour < 24; hour += 1) {
          const pools = greetingPools(at({ month, day, hour, weekday: hour % 7 }), busy);
          for (const line of [...pools.special, ...pools.personal, ...pools.general]) {
            expect(line).toContain('{name}');
          }
        }
      }
    }
  });
});

describe('pickGreeting', () => {
  /** A random source that returns the given draws in order. */
  const draws = (...values: number[]) => {
    let next = 0;
    return () => values[next++] ?? 0;
  };

  it('favors a special day, and still leaves room for the rest', () => {
    const christmas = at({ month: 12, day: 25 });
    expect(pickGreeting(christmas, NO_GREETING_FACTS, draws(0.1, 0.99))).toBe(
      'Merry Christmas, {name}!',
    );
    expect(
      greetingPools(christmas, NO_GREETING_FACTS).general.includes(
        pickGreeting(christmas, NO_GREETING_FACTS, draws(0.6, 0.9, 0.1)),
      ),
    ).toBe(true);
  });

  it('picks a personal line about a third of the time', () => {
    const known = facts({ topGenre: 'Jazz' });
    expect(pickGreeting(at(), known, draws(0.2, 0))).toBe('More Jazz today, {name}?');
    expect(
      greetingPools(at(), known).general.includes(pickGreeting(at(), known, draws(0.5, 0))),
    ).toBe(true);
  });
});

describe('formatGreeting', () => {
  it('greets by first name', () => {
    expect(formatGreeting('Hey, {name}!', 'John Doe')).toBe('Hey, John!');
    expect(formatGreeting('Still up, {name}?', '  Ada  ')).toBe('Still up, Ada?');
  });

  it('falls back to a nameless welcome when there is no name to use', () => {
    expect(formatGreeting('Hey, {name}!', '')).toBe('Welcome back!');
    expect(formatGreeting('Still up, {name}?', '   ')).toBe('Welcome back!');
  });

  it('inserts a name carrying `$` exactly as written', () => {
    expect(formatGreeting('Hey, {name}!', 'DJ$&')).toBe('Hey, DJ$&!');
    expect(formatGreeting('Hey, {name}!', "A$'B")).toBe("Hey, A$'B!");
  });
});

describe('localClock', () => {
  it('reads the wall-clock hour of the zone, not of the server', () => {
    const noonUtc = new Date('2026-08-02T12:00:00Z');
    expect(localClock(noonUtc, 'UTC')?.hour).toBe(12);
    expect(localClock(noonUtc, 'Europe/Berlin')?.hour).toBe(14);
    expect(localClock(noonUtc, 'America/New_York')?.hour).toBe(8);
  });

  it('counts midnight as hour zero', () => {
    expect(localClock(new Date('2026-08-02T00:30:00Z'), 'UTC')?.hour).toBe(0);
  });

  it('reads the date and weekday of the zone, which can differ from the server’s', () => {
    // 2026-08-02 is a Sunday; late Sunday in UTC is already Monday in Tokyo.
    const lateSundayUtc = new Date('2026-08-02T20:00:00Z');
    expect(localClock(lateSundayUtc, 'UTC')).toMatchObject({
      year: 2026,
      month: 8,
      day: 2,
      weekday: 0,
    });
    expect(localClock(lateSundayUtc, 'Asia/Tokyo')).toMatchObject({ month: 8, day: 3, weekday: 1 });
  });

  it('tells the hemisphere from the zone’s daylight saving, and not when it has none', () => {
    const now = new Date('2026-08-02T12:00:00Z');
    expect(localClock(now, 'Europe/Berlin')?.hemisphere).toBe('north');
    expect(localClock(now, 'Australia/Sydney')?.hemisphere).toBe('south');
    expect(localClock(now, 'Asia/Tokyo')?.hemisphere).toBeNull();
  });

  it('gives up on a zone it cannot resolve', () => {
    expect(localClock(new Date('2026-08-02T12:00:00Z'), 'Not/AZone')).toBeNull();
  });
});

describe('anniversaryYears', () => {
  it('counts whole years on the account’s calendar day only', () => {
    const joined = at({ year: 2024, month: 11, day: 20 });
    expect(anniversaryYears(joined, at({ year: 2026, month: 11, day: 20 }))).toBe(2);
    expect(anniversaryYears(joined, at({ year: 2026, month: 11, day: 21 }))).toBeNull();
    expect(anniversaryYears(joined, at({ year: 2024, month: 11, day: 20 }))).toBeNull();
    expect(anniversaryYears(null, at())).toBeNull();
  });
});
