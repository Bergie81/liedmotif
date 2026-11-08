import { describe, expect, it } from 'vitest';
import { limitWindowStarts } from './window';

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
