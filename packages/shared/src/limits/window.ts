// Usage-limit window math — the SINGLE reset path for daily/monthly generation
// limits. The day/month windows reset at local midnight
// in the instance's `resetTimezone` (falling back to `INSTANCE_TIMEZONE`/`UTC`
// at seed time). Session Repeat auto-resume keys off this SAME calculation — do
// not introduce a second reset path.
//
// Pure: every function takes the current instant explicitly, so it is fully
// deterministic and testable without faking the clock.

/** The start instants of the current daily and monthly limit windows (as UTC). */
export interface LimitWindowStarts {
  /** Most recent local midnight in `resetTimezone`, as a UTC instant. */
  dayStart: Date;
  /** Most recent local first-of-month midnight in `resetTimezone`, as a UTC instant. */
  monthStart: Date;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Build a fixed-format `Intl.DateTimeFormat`, or `null` for an invalid timezone. */
function zonedFormatter(timeZone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return null;
  }
}

/** Read the wall-clock parts of `date` as seen in the formatter's timezone. */
function partsOf(formatter: Intl.DateTimeFormat, date: Date): LocalParts {
  const map: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') map[part.type] = Number(part.value);
  }
  return {
    year: map.year ?? 1970,
    month: map.month ?? 1,
    day: map.day ?? 1,
    hour: map.hour ?? 0,
    minute: map.minute ?? 0,
    second: map.second ?? 0,
  };
}

/**
 * Resolve a wall-clock instant (year/month/day 00:00:00 local) in `formatter`'s
 * timezone to its UTC instant. `local = utc + offset`, and the offset itself
 * depends on the instant (DST), so we converge in two passes: guess the offset
 * at the naive-UTC instant, correct, then re-read the offset at the corrected
 * instant to settle transitions near the boundary.
 */
function localMidnightToUtc(
  formatter: Intl.DateTimeFormat,
  year: number,
  month: number,
  day: number,
): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offsetAt = (instant: number): number => {
    const p = partsOf(formatter, new Date(instant));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant;
  };
  let instant = wallAsUtc - offsetAt(wallAsUtc);
  instant = wallAsUtc - offsetAt(instant);
  // In zones that spring forward AT midnight (America/Santiago, America/Havana)
  // local 00:00 does not exist, and the instant above reads as the previous
  // day's last hour. Stepping forward by the shortfall lands on the transition
  // instant — the first moment of the requested day.
  const settled = partsOf(formatter, new Date(instant));
  const settledWall = Date.UTC(
    settled.year,
    settled.month - 1,
    settled.day,
    settled.hour,
    settled.minute,
    settled.second,
  );
  if (settledWall < wallAsUtc) instant += wallAsUtc - settledWall;
  return new Date(instant);
}

/** The formatter for `resetTimezone`; a blank or invalid one reads as `UTC`. */
function resetFormatter(resetTimezone: string): Intl.DateTimeFormat {
  return zonedFormatter(resetTimezone.trim() || 'UTC') ?? zonedFormatter('UTC')!;
}

/**
 * The start instants of the current daily and monthly limit windows for `now`,
 * resetting at local midnight in `resetTimezone`. A blank or invalid timezone
 * falls back to `UTC` rather than throwing (defensive: a malformed setting must
 * never break limit accounting).
 */
export function limitWindowStarts(now: Date, resetTimezone: string): LimitWindowStarts {
  const formatter = resetFormatter(resetTimezone);
  const { year, month, day } = partsOf(formatter, now);
  return {
    dayStart: localMidnightToUtc(formatter, year, month, day),
    monthStart: localMidnightToUtc(formatter, year, month, 1),
  };
}

/** The day `now` falls in, as `resetTimezone` sees it. */
export interface LimitDay {
  /** The local calendar date, `YYYY-MM-DD`: the key a per-day count is kept under. */
  date: string;
  /** The next local midnight, as a UTC instant: when a per-day count starts over. */
  endsAt: Date;
}

/**
 * The local day of `now` in `resetTimezone` and the instant it ends — the same
 * midnight `limitWindowStarts` resets on, seen from the other side.
 */
export function limitDay(now: Date, resetTimezone: string): LimitDay {
  const formatter = resetFormatter(resetTimezone);
  const { year, month, day } = partsOf(formatter, now);
  const two = (value: number) => String(value).padStart(2, '0');
  return {
    date: `${year}-${two(month)}-${two(day)}`,
    // A day past the month's last rolls into the next month (`Date.UTC`).
    endsAt: localMidnightToUtc(formatter, year, month, day + 1),
  };
}
