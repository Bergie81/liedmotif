import { describe, expect, it } from 'vitest';
import { limitDay, limitWindowStarts } from './window';

// The usage-limit window math is the SINGLE reset path (resetTimezone /
// INSTANCE_TIMEZONE). Day/month starts are the most-recent local-midnight and
// first-of-month-midnight instants, expressed as UTC. Session Repeat auto-resume
// keys off this same calculation — there is no second reset path.
describe('limitWindowStarts', () => {
  it('computes UTC day/month starts in UTC', () => {
    const now = new Date('2026-06-29T14:30:00.000Z');
    const { dayStart, monthStart } = limitWindowStarts(now, 'UTC');
    expect(dayStart.toISOString()).toBe('2026-06-29T00:00:00.000Z');
    expect(monthStart.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('resets at local midnight for a positive-offset zone (Asia/Tokyo, UTC+9, no DST)', () => {
    // 2026-06-29T14:30Z is 2026-06-29T23:30 in Tokyo → same local day; local
    // midnight (00:00 JST) is 2026-06-28T15:00Z.
    const now = new Date('2026-06-29T14:30:00.000Z');
    const { dayStart, monthStart } = limitWindowStarts(now, 'Asia/Tokyo');
    expect(dayStart.toISOString()).toBe('2026-06-28T15:00:00.000Z');
    expect(monthStart.toISOString()).toBe('2026-05-31T15:00:00.000Z');
  });

  it('rolls the local day when UTC and local fall on different dates', () => {
    // 2026-06-30T02:00Z is 2026-06-30T11:00 JST; local midnight = 2026-06-29T15:00Z.
    const now = new Date('2026-06-30T02:00:00.000Z');
    const { dayStart } = limitWindowStarts(now, 'Asia/Tokyo');
    expect(dayStart.toISOString()).toBe('2026-06-29T15:00:00.000Z');
  });

  it('starts the day at the transition when DST skips local midnight (America/Santiago)', () => {
    // 2026-09-06 springs forward at 00:00 → 01:00 local (UTC-4 → UTC-3), so the
    // day's first instant is 01:00 local = 04:00Z, not 23:00 on Sep 5.
    const now = new Date('2026-09-06T15:00:00.000Z');
    expect(limitWindowStarts(now, 'America/Santiago').dayStart.toISOString()).toBe(
      '2026-09-06T04:00:00.000Z',
    );
  });

  it('falls back to UTC for an invalid timezone instead of throwing', () => {
    const now = new Date('2026-06-29T14:30:00.000Z');
    const { dayStart } = limitWindowStarts(now, 'Not/AZone');
    expect(dayStart.toISOString()).toBe('2026-06-29T00:00:00.000Z');
  });

  it('treats a blank timezone as UTC', () => {
    const now = new Date('2026-06-29T14:30:00.000Z');
    expect(limitWindowStarts(now, '  ').dayStart.toISOString()).toBe('2026-06-29T00:00:00.000Z');
  });
});

describe('limitDay', () => {
  it('names the local date and the instant the next one starts', () => {
    // 2026-06-29T14:30Z is 23:30 on the 29th in Tokyo; the 30th starts at 15:00Z.
    const { date, endsAt } = limitDay(new Date('2026-06-29T14:30:00.000Z'), 'Asia/Tokyo');
    expect(date).toBe('2026-06-29');
    expect(endsAt.toISOString()).toBe('2026-06-29T15:00:00.000Z');
  });

  it('is already on the next date once local midnight has passed', () => {
    const { date, endsAt } = limitDay(new Date('2026-06-29T15:00:00.000Z'), 'Asia/Tokyo');
    expect(date).toBe('2026-06-30');
    expect(endsAt.toISOString()).toBe('2026-06-30T15:00:00.000Z');
  });

  it('ends the last day of a month at the first of the next', () => {
    const { date, endsAt } = limitDay(new Date('2026-12-31T23:59:59.000Z'), 'UTC');
    expect(date).toBe('2026-12-31');
    expect(endsAt.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('ends a day that loses an hour to DST 23 hours after it started (Europe/Berlin)', () => {
    // 2026-03-29 springs forward at 02:00 local: the day runs 23:00Z to 22:00Z.
    const { date, endsAt } = limitDay(new Date('2026-03-29T12:00:00.000Z'), 'Europe/Berlin');
    expect(date).toBe('2026-03-29');
    expect(endsAt.toISOString()).toBe('2026-03-29T22:00:00.000Z');
  });

  it('falls back to UTC for an invalid timezone', () => {
    expect(limitDay(new Date('2026-06-29T23:30:00.000Z'), 'Not/AZone').date).toBe('2026-06-29');
  });
});
