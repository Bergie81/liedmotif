// The home headline greets the listener by name. Greetings are templates with
// a `{name}` slot rather than finished lines, because the pick happens on the
// server (once per load, so a reload re-rolls it) while the name lives in the
// client-side chrome context.

/** Warm and neutral: safe to land on a 40px display headline at any hour. */
const ANY_HOUR: readonly string[] = [
  'Hi, {name}!',
  'Hello, {name}!',
  'Hey, {name}!',
  'Hey there, {name}!',
  'Hiya, {name}!',
  'Welcome back, {name}!',
  'Good to see you, {name}!',
  'There you are, {name}.',
];

/** Dayparts by local hour, first match wins. */
const DAYPARTS: ReadonlyArray<{ from: number; to: number; greetings: readonly string[] }> = [
  { from: 5, to: 11, greetings: ['Good morning, {name}!', 'Morning, {name}!'] },
  { from: 12, to: 17, greetings: ['Good afternoon, {name}!'] },
  { from: 18, to: 22, greetings: ['Good evening, {name}.', 'Evening, {name}.'] },
  { from: 23, to: 4, greetings: ['Still up, {name}?', 'Late one, {name}?'] },
];

function daypartGreetings(hour: number): readonly string[] {
  const part = DAYPARTS.find(({ from, to }) =>
    // A window that crosses midnight covers the hours on both sides of it.
    from <= to ? hour >= from && hour <= to : hour >= from || hour <= to,
  );
  return part?.greetings ?? [];
}

/**
 * One greeting template for this load. `hour` is the local wall-clock hour and
 * widens the pool with that daypart's greetings; pass null when the hour is
 * unknown (a failed timezone read) to draw from the hour-independent pool only.
 */
export function pickGreeting(hour: number | null, random: () => number): string {
  const pool = hour == null ? ANY_HOUR : [...ANY_HOUR, ...daypartGreetings(hour)];
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  return pool[index]!;
}

/**
 * The wall-clock hour (0–23) in `timezone`, or null when the zone is not one
 * the runtime knows — the greeting then simply skips its daypart, which beats
 * greeting a listener good morning at midnight because a container runs on UTC.
 */
export function hourInTimezone(now: Date, timezone: string): number | null {
  try {
    const hour = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(now);
    const parsed = Number.parseInt(hour, 10);
    return Number.isNaN(parsed) ? null : parsed;
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
  return template.replace('{name}', firstName);
}
