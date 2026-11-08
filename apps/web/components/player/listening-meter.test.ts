import { describe, expect, it } from 'vitest';
import {
  createAudibleAdvanceProbe,
  createListeningMeter,
  type ListeningReport,
} from './listening-meter';

function harness(send?: (report: ListeningReport) => void) {
  const sent: ListeningReport[] = [];
  let clock = Date.parse('2026-09-10T12:00:00Z');
  let ids = 0;
  const meter = createListeningMeter({
    send: send ?? ((report) => sent.push(report)),
    now: () => clock,
    newOccurrenceId: () => `occurrence-${ids++}`,
  });
  return {
    meter,
    sent,
    /** Advance the clock one second at a time, observing each. */
    sleep(ms: number) {
      clock += ms;
    },
    run(seconds: number, advancing: boolean) {
      for (let i = 0; i < seconds; i++) {
        clock += 1000;
        meter.observe(advancing);
      }
    },
  };
}

describe('listening meter', () => {
  it('credits only time observed advancing, under one occurrence across a pause', () => {
    const h = harness();
    h.meter.begin({ trackId: 't1', sessionId: 's1', surface: 'session' });
    h.run(12, true);
    h.run(60, false);
    h.run(8, true);
    h.meter.end('ended');

    const last = h.sent.at(-1)!;
    expect(last).toMatchObject({
      occurrenceId: 'occurrence-0',
      trackId: 't1',
      sessionId: 's1',
      listenedMs: 20_000,
      endReason: 'ended',
    });
    expect(new Set(h.sent.map((r) => r.occurrenceId)).size).toBe(1);
  });

  it('saves progress periodically with a growing cumulative total', () => {
    const h = harness();
    h.meter.begin({ trackId: 't1', sessionId: 's1', surface: 'session' });
    h.run(35, true);
    expect(h.sent.map((r) => r.listenedMs)).toEqual([10_000, 20_000, 30_000]);
    expect(h.sent.every((r) => r.endReason === null)).toBe(true);
  });

  it('closes the previous occurrence when another Track begins, and a replay gets a new one', () => {
    const h = harness();
    h.meter.begin({ trackId: 't1', sessionId: 's1', surface: 'session' });
    h.run(5, true);
    h.meter.begin({ trackId: 't1', sessionId: 's1', surface: 'session' });
    h.run(5, true);
    h.meter.end('stopped');

    expect(h.sent).toMatchObject([
      { occurrenceId: 'occurrence-0', listenedMs: 5000, endReason: 'replaced' },
      { occurrenceId: 'occurrence-1', listenedMs: 5000, endReason: 'stopped' },
    ]);
  });

  it('does not credit a gap the page slept through', () => {
    const h = harness();
    h.meter.begin({ trackId: 't1', sessionId: 's1', surface: 'session' });
    h.run(3, true);
    // One observation arriving an hour late is a suspended tab, not an hour of listening.
    h.sleep(3_600_000);
    h.meter.observe(true);
    h.meter.end('stopped');
    expect(h.sent.at(-1)!.listenedMs).toBe(3000);
  });

  it('saves as soon as playback stops advancing', () => {
    const h = harness();
    h.meter.begin({ trackId: 't1', sessionId: 's1', surface: 'session' });
    h.run(4, true);
    h.run(1, false);
    expect(h.sent).toMatchObject([{ listenedMs: 5000, endReason: null }]);
  });

  it('sends nothing for an occurrence that never advanced', () => {
    const h = harness();
    h.meter.begin({ trackId: 't1', sessionId: 's1', surface: 'session' });
    h.meter.end('stopped');
    expect(h.sent).toEqual([]);
  });

  it('keeps metering when sending throws', () => {
    let attempts = 0;
    const h = harness(() => {
      attempts++;
      throw new Error('offline');
    });
    h.meter.begin({ trackId: 't1', sessionId: 's1', surface: 'session' });
    expect(() => h.run(25, true)).not.toThrow();
    expect(() => h.meter.end('ended')).not.toThrow();
    expect(attempts).toBe(3);
  });
  it('reports a Playlist or preview occurrence under its own surface with no Session', () => {
    const h = harness();
    h.meter.begin({ trackId: 't1', sessionId: null, surface: 'playlist' });
    h.run(5, true);
    h.meter.begin({ trackId: 't1', sessionId: null, surface: 'preview' });
    h.run(5, true);
    h.meter.end('stopped');

    expect(h.sent.map((r) => [r.occurrenceId, r.surface, r.sessionId, r.endReason])).toEqual([
      ['occurrence-0', 'playlist', null, 'replaced'],
      ['occurrence-1', 'preview', null, 'stopped'],
    ]);
  });

  it('continues the open occurrence when the same Track is resumed, however often play fires', () => {
    const h = harness();
    const target = { trackId: 't1', sessionId: null, surface: 'preview' as const };
    h.meter.resume(target);
    h.meter.resume(target);
    h.run(10, true);
    // The pause is seen one tick after the audio last moved, so that second counts.
    h.run(30, false);
    h.meter.resume(target);
    h.meter.resume(target);
    h.run(10, true);
    h.meter.end('ended');

    expect(new Set(h.sent.map((r) => r.occurrenceId))).toEqual(new Set(['occurrence-0']));
    expect(h.sent.at(-1)).toMatchObject({ listenedMs: 21_000, endReason: 'ended' });
  });

  it('opens a new occurrence when a finished Track is played again or another Track resumes', () => {
    const h = harness();
    const target = { trackId: 't1', sessionId: null, surface: 'preview' as const };
    h.meter.resume(target);
    h.run(5, true);
    h.meter.end('ended');
    h.meter.resume(target);
    h.run(5, true);
    h.meter.resume({ ...target, trackId: 't2' });
    h.run(5, true);
    h.meter.end('stopped');

    expect(h.sent.map((r) => [r.occurrenceId, r.trackId, r.listenedMs, r.endReason])).toEqual([
      ['occurrence-0', 't1', 5_000, 'ended'],
      ['occurrence-1', 't1', 5_000, 'replaced'],
      ['occurrence-2', 't2', 5_000, 'stopped'],
    ]);
  });
  it('splits a crossfade between its two Tracks while each keeps what it actually played', () => {
    const h = harness();
    h.meter.begin({ trackId: 't1', sessionId: 's1', surface: 'session' });
    h.run(40, true);
    h.meter.begin({ trackId: 't2', sessionId: 's1', surface: 'session' }, { overlapMs: 10_000 });
    h.run(9, true);
    h.sleep(1000);
    h.meter.close('t1', 'ended');
    h.run(30, true);
    h.meter.end('stopped');

    const final = (trackId: string) => h.sent.filter((r) => r.trackId === trackId).at(-1)!;
    expect(final('t1')).toMatchObject({ listenedMs: 45_000, playedMs: 50_000, endReason: 'ended' });
    expect(final('t2')).toMatchObject({
      listenedMs: 35_000,
      playedMs: 40_000,
      endReason: 'stopped',
    });
    // 80 s elapsed on one player: the credits add up to exactly that.
    expect(final('t1').listenedMs + final('t2').listenedMs).toBe(80_000);
  });

  it('ends the fading tail, not the new occurrence, when a Track crossfades into itself', () => {
    const h = harness();
    h.meter.begin({ trackId: 't1', sessionId: 's1', surface: 'session' });
    h.run(20, true);
    h.meter.begin({ trackId: 't1', sessionId: 's1', surface: 'session' }, { overlapMs: 4000 });
    h.run(3, true);
    h.sleep(1000);
    h.meter.close('t1', 'ended');
    h.run(6, true);
    h.meter.end('stopped');

    expect(h.sent.filter((r) => r.endReason !== null)).toMatchObject([
      { occurrenceId: 'occurrence-0', listenedMs: 22_000, playedMs: 24_000, endReason: 'ended' },
      { occurrenceId: 'occurrence-1', listenedMs: 8_000, playedMs: 10_000, endReason: 'stopped' },
    ]);
  });

  it('stops sharing once the fade has played out, even if the tail never reports its end', () => {
    const h = harness();
    h.meter.begin({ trackId: 't1', sessionId: 's1', surface: 'session' });
    h.run(20, true);
    h.meter.begin({ trackId: 't2', sessionId: 's1', surface: 'session' }, { overlapMs: 4000 });
    h.run(10, true);
    h.meter.end('stopped');

    expect(h.sent.filter((r) => r.endReason !== null)).toMatchObject([
      { trackId: 't1', listenedMs: 22_000, playedMs: 24_000, endReason: 'stopped' },
      { trackId: 't2', listenedMs: 8_000, playedMs: 10_000, endReason: 'stopped' },
    ]);
  });

  it('ends an occurrence once, however many end callbacks arrive, and ignores a Track it is not metering', () => {
    const h = harness();
    h.meter.begin({ trackId: 't1', sessionId: 's1', surface: 'session' });
    h.run(5, true);
    h.meter.close('t9', 'failed');
    h.meter.close('t1', 'navigated');
    h.meter.close('t1', 'ended');
    h.meter.end('stopped');

    expect(h.sent).toMatchObject([{ listenedMs: 5000, endReason: 'navigated' }]);
  });

  it('tells a deliberate replay from a passive loop from an ordinary advance', () => {
    const h = harness();
    const start = (trackId: string, origin?: 'user' | 'auto') => {
      h.meter.begin({ trackId, sessionId: 's1', surface: 'session' }, { origin });
      h.run(2, true);
      h.meter.close(trackId, 'ended');
    };
    start('t1', 'user');
    start('t1');
    start('t1', 'user');
    start('t2');

    expect(h.sent.map((r) => r.origin)).toEqual(['user', 'loop', 'user', 'auto']);
  });

  it('saves unsaved progress on demand, for a page about to go away', () => {
    const h = harness();
    h.meter.begin({ trackId: 't1', sessionId: 's1', surface: 'session' });
    h.run(4, true);
    h.meter.flush();
    h.meter.flush();
    expect(h.sent).toMatchObject([{ listenedMs: 4000, endReason: null }]);
  });
});

describe('audible advance probe', () => {
  it('sees listening only while the position moves and the app lets it be heard', () => {
    let sample = { position: 0 as number | null, audible: true };
    const advancing = createAudibleAdvanceProbe(() => sample);
    const at = (position: number | null, audible = true) => {
      sample = { position, audible };
      return advancing();
    };
    expect(at(1)).toBe(true);
    // Buffering: the clock stands still.
    expect(at(1)).toBe(false);
    // A seek is movement like any other second — it earns one tick, not the distance.
    expect(at(90)).toBe(true);
    // App mute or zero volume.
    expect(at(91, false)).toBe(false);
    expect(at(92)).toBe(true);
    expect(at(null)).toBe(false);
  });
});
