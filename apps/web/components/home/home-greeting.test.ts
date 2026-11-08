import { describe, expect, it } from 'vitest';
import { formatGreeting, hourInTimezone, pickGreeting } from './home-greeting';

/** Every greeting reachable at this hour, swept by feeding the picker fixed
 * random values across [0,1) — the pool is observable only through the pick. */
function poolAt(hour: number | null): Set<string> {
  const seen = new Set<string>();
  for (let step = 0; step < 100; step += 1) seen.add(pickGreeting(hour, () => step / 100));
  return seen;
}

describe('pickGreeting', () => {
  it('offers the time-of-day greeting for the hour and no other daypart', () => {
    const morning = poolAt(8);
    expect(morning).toContain('Good morning, {name}!');
    expect(morning).not.toContain('Good evening, {name}.');
    expect(morning).not.toContain('Still up, {name}?');
  });

  it('keeps the hour-independent greetings reachable at every hour', () => {
    for (const hour of [0, 5, 12, 18, 23]) {
      expect(poolAt(hour)).toContain('Hey, {name}!');
    }
  });

  it('drops every daypart greeting when the hour is unknown', () => {
    const unknown = poolAt(null);
    expect(unknown).toContain('Hey, {name}!');
    expect(unknown).not.toContain('Good morning, {name}!');
    expect(unknown).not.toContain('Good afternoon, {name}!');
    expect(unknown).not.toContain('Good evening, {name}.');
    expect(unknown).not.toContain('Still up, {name}?');
  });

  it('greets the small hours as late night on both sides of midnight', () => {
    expect(poolAt(23)).toContain('Still up, {name}?');
    expect(poolAt(2)).toContain('Still up, {name}?');
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
});

describe('hourInTimezone', () => {
  it('reads the wall-clock hour of the zone, not of the server', () => {
    const noonUtc = new Date('2026-08-02T12:00:00Z');
    expect(hourInTimezone(noonUtc, 'UTC')).toBe(12);
    expect(hourInTimezone(noonUtc, 'Europe/Berlin')).toBe(14);
    expect(hourInTimezone(noonUtc, 'America/New_York')).toBe(8);
  });

  it('counts midnight as hour zero', () => {
    expect(hourInTimezone(new Date('2026-08-02T00:30:00Z'), 'UTC')).toBe(0);
  });

  it('gives up on a zone it cannot resolve', () => {
    expect(hourInTimezone(new Date('2026-08-02T12:00:00Z'), 'Not/AZone')).toBeNull();
  });
});
