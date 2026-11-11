import { describe, expect, it } from 'vitest';
import {
  isSupportedTimezone,
  supportedTimezones,
  timezoneGroups,
  timezoneLabel,
} from './timezones';

describe('supportedTimezones', () => {
  it('leads with UTC, then sorts the rest', () => {
    const zones = supportedTimezones();
    expect(zones[0]).toBe('UTC');
    expect(zones).toContain('Europe/Berlin');
    // UTC is not repeated inside the sorted tail.
    expect(zones.filter((zone) => zone === 'UTC')).toHaveLength(1);
    const tail = zones.slice(1);
    expect(tail).toEqual([...tail].sort((a, b) => a.localeCompare(b)));
  });

  it('offers only zones the runtime will accept', () => {
    for (const zone of supportedTimezones()) expect(isSupportedTimezone(zone)).toBe(true);
  });
});

describe('isSupportedTimezone', () => {
  it('rejects a blank or unknown zone', () => {
    for (const zone of ['', '   ', 'Mars/Olympus_Mons', 'Europe/Nowhere']) {
      expect(isSupportedTimezone(zone)).toBe(false);
    }
  });

  it('rejects a bare UTC offset, which Postgres reads with the opposite sign', () => {
    for (const zone of ['+05:00', '-0300', '+05', ' +05:00']) {
      expect(isSupportedTimezone(zone)).toBe(false);
    }
    expect(isSupportedTimezone('Etc/GMT+5')).toBe(true);
  });
});

describe('timezoneGroups', () => {
  it('groups by IANA area and keeps UTC in its own', () => {
    const groups = timezoneGroups(['UTC', 'Europe/Berlin', 'Europe/London', 'Asia/Tokyo']);
    expect(groups).toEqual([
      { area: 'UTC', zones: ['UTC'] },
      { area: 'Europe', zones: ['Europe/Berlin', 'Europe/London'] },
      { area: 'Asia', zones: ['Asia/Tokyo'] },
    ]);
  });

  it('covers every zone exactly once', () => {
    const zones = supportedTimezones();
    expect(timezoneGroups(zones).flatMap((group) => group.zones)).toEqual(zones);
  });
});

describe('timezoneLabel', () => {
  it('drops the area and reads the rest as words', () => {
    expect(timezoneLabel('Europe/Berlin')).toBe('Berlin');
    expect(timezoneLabel('America/Los_Angeles')).toBe('Los Angeles');
    expect(timezoneLabel('America/Argentina/Buenos_Aires')).toBe('Argentina — Buenos Aires');
    expect(timezoneLabel('UTC')).toBe('UTC');
  });
});
