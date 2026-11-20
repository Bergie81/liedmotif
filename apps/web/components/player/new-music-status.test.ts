import { describe, expect, it } from 'vitest';
import type { SessionGenerationStatus } from '@liedmotif/shared';
import { presentNewMusicStatus } from './new-music-status';

const onNoLimit = {
  sessionMode: 'keep_going',
  targetDurationMinutes: null,
  generatedDurationSeconds: 720,
  unknownDurationTrackCount: 0,
} as const;
const on60 = { ...onNoLimit, targetDurationMinutes: 60 } as const;
const off = { ...onNoLimit, sessionMode: 'repeat' } as const;

describe('what the player says about new music', () => {
  it('says how many Tracks are being bought', () => {
    expect(
      presentNewMusicStatus({ session: onNoLimit, generatingAhead: 2, generationStatus: 'ok' }),
    ).toMatchObject({
      text: 'Generating 2',
      short: 'Generating 2',
      detail: null,
      icon: 'generating',
      sentence: 'Buying 2 new tracks right now.',
    });
  });

  it('shows what is ahead while generating towards a duration target', () => {
    expect(
      presentNewMusicStatus({
        session: { ...on60, generatedDurationSeconds: 22 * 60 + 40 },
        generatingAhead: 1,
        generationStatus: 'ok',
      }),
    ).toMatchObject({
      text: 'Generating 1',
      detail: '22 / 60 min',
      icon: 'generating',
      sentence: 'Buying 1 new track right now.',
    });
  });

  it('says paid work is finishing once new music is off', () => {
    expect(
      presentNewMusicStatus({ session: off, generatingAhead: 2, generationStatus: 'ok' }),
    ).toMatchObject({
      text: 'Finishing 2',
      short: 'Finishing 2',
      detail: null,
      icon: 'generating',
      sentence:
        'New Music is off. 2 tracks already started will finish, then nothing more is bought.',
    });
  });

  it('counts generated music against the target while nothing is being bought', () => {
    expect(
      presentNewMusicStatus({ session: on60, generatingAhead: 0, generationStatus: 'ok' }),
    ).toMatchObject({
      text: '12 / 60 min Generated',
      short: '12 / 60 min',
      icon: 'target',
      sentence:
        'Nothing is being bought right now. New tracks come when the queue runs low, up to 48 more min, then it repeats.',
    });
  });

  it('marks the count as partial and says generation waits when a duration is unknown', () => {
    expect(
      presentNewMusicStatus({
        session: { ...on60, unknownDurationTrackCount: 1 },
        generatingAhead: 0,
        generationStatus: 'ok',
      }),
    ).toMatchObject({
      text: '12+ / 60 min Generated',
      short: '12+ / 60 min',
      icon: 'target',
      generatedLine: '12+ / 60 min generated',
      sentence:
        'Some audio durations are unknown. New tracks wait until they are measured, and your music stays playable.',
    });
  });

  it('says the target is finished once it is reached', () => {
    expect(
      presentNewMusicStatus({
        session: { ...on60, generatedDurationSeconds: 62 * 60 },
        generatingAhead: 0,
        generationStatus: 'ok',
      }),
    ).toMatchObject({
      text: 'New Music Finished · 62 min',
      short: 'Done · 62 min',
      icon: 'finished',
      sentence: 'The 60 min target is reached. Repeating, nothing more is bought.',
    });
  });

  it('says new music is on without a limit', () => {
    expect(
      presentNewMusicStatus({ session: onNoLimit, generatingAhead: 0, generationStatus: 'ok' }),
    ).toMatchObject({
      text: 'New Music On · No Limit',
      short: 'On · No Limit',
      icon: 'no-limit',
      generatedLine: '12 min generated so far',
      sentence: 'Keeps buying new tracks for as long as you listen.',
    });
  });

  it('says when a cost limit has stopped the buying', () => {
    expect(
      presentNewMusicStatus({
        session: onNoLimit,
        generatingAhead: 0,
        generationStatus: 'repeat_cost_limit',
      }),
    ).toMatchObject({
      text: 'Limit Reached · Repeating',
      short: 'Limit · Repeat',
      icon: 'paused',
      sentence: 'Your generation limit is used up. Nothing is being bought.',
    });
  });

  it.each<SessionGenerationStatus>([
    'provider_credits',
    'provider_rate_limited',
    'worker_stalled',
    'provider_error',
  ])('says new music is paused during %s, not on', (generationStatus) => {
    expect(
      presentNewMusicStatus({ session: onNoLimit, generatingAhead: 0, generationStatus }),
    ).toMatchObject({
      text: 'New Music Paused',
      short: 'Paused',
      icon: 'paused',
      sentence: 'New Music is on, but a problem is holding it. Nothing is being bought.',
    });
  });

  it('says paused, not Generating, while the worker is silent on Tracks in flight', () => {
    expect(
      presentNewMusicStatus({
        session: onNoLimit,
        generatingAhead: 2,
        generationStatus: 'worker_stalled',
      }).text,
    ).toBe('New Music Paused');
  });

  it('still says Finishing for an Off Session whose Tracks in flight have stalled', () => {
    expect(
      presentNewMusicStatus({
        session: off,
        generatingAhead: 2,
        generationStatus: 'worker_stalled',
      }).text,
    ).toBe('Finishing 2');
  });

  it.each([
    ['no limit', onNoLimit, 'New Music On · No Limit'],
    ['a target', on60, '12 / 60 min Generated'],
  ])('keeps the wording but says a loop is holding the buying with %s', (_kind, session, text) => {
    expect(
      presentNewMusicStatus({
        session,
        generatingAhead: 0,
        generationStatus: 'ok',
        loopHeld: true,
      }),
    ).toMatchObject({
      text,
      sentence: 'A loop is playing, so nothing is being bought until it ends.',
    });
  });

  it('treats the legacy buffer-complete status as nothing wrong', () => {
    expect(
      presentNewMusicStatus({
        session: onNoLimit,
        generatingAhead: 0,
        generationStatus: 'repeat_buffer_complete',
      }).text,
    ).toBe('New Music On · No Limit');
  });

  it.each<SessionGenerationStatus>(['repeat_cost_limit', 'provider_error'])(
    'says off when the owner turned it off, whatever %s would block',
    (generationStatus) => {
      expect(
        presentNewMusicStatus({ session: off, generatingAhead: 0, generationStatus }),
      ).toMatchObject({
        text: 'New Music Off',
        short: 'New Music Off',
        icon: 'off',
        sentence: 'Playing the tracks you already have. Nothing is being bought.',
      });
    },
  );

  it('keeps a finished target finished even if a limit is also hit', () => {
    expect(
      presentNewMusicStatus({
        session: { ...on60, generatedDurationSeconds: 60 * 60 },
        generatingAhead: 0,
        generationStatus: 'repeat_cost_limit',
      }).text,
    ).toBe('New Music Finished · 60 min');
  });

  it('puts Tracks in flight ahead of a fault that has not silenced them', () => {
    expect(
      presentNewMusicStatus({
        session: onNoLimit,
        generatingAhead: 2,
        generationStatus: 'provider_error',
      }).text,
    ).toBe('Generating 2');
  });
});
