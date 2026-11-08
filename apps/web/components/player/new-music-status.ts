import {
  isDurationTargetReached,
  type SessionGenerationStatus,
  type SessionSummary,
} from '@liedmotif/shared';

export type NewMusicIcon = 'generating' | 'target' | 'no-limit' | 'finished' | 'paused' | 'off';

export interface NewMusicStatus {
  /** The full wording. */
  text: string;
  /** Fits a phone's header row beside its icons. */
  short: string;
  /** Duration progress, on its own line while Tracks are being bought. */
  detail: string | null;
  /** What is true now and what will happen next. */
  sentence: string;
  /** How much music the Session has generated so far. */
  generatedLine: string;
  icon: NewMusicIcon;
}

/** The status on one line, for a surface that gives it no second line. */
export function newMusicStatusLine(status: NewMusicStatus): string {
  return status.detail ? `${status.text} · ${status.detail}` : status.text;
}

const LOOP_HOLD_SENTENCE = 'A loop is playing, so nothing is being bought until it ends.';

export function tracksWord(count: number): string {
  return count === 1 ? 'Track' : 'Tracks';
}

/**
 * Whether anything is, or will be, bought — stated from what will actually
 * happen rather than from the stored policy, which stays Keep Going after a
 * target or a limit has ended the buying. Tracks in flight outrank everything
 * because they are spending now, unless the worker has gone silent on them. An
 * owner's Off and a reached target are settled endings, so they outrank a limit
 * or fault that has nothing left to block.
 */
export function presentNewMusicStatus({
  session,
  generatingAhead,
  generationStatus,
  loopHeld = false,
}: {
  session: Pick<
    SessionSummary,
    | 'sessionMode'
    | 'targetDurationMinutes'
    | 'generatedDurationSeconds'
    | 'unknownDurationTrackCount'
  >;
  /** Tracks on the way (`countGeneratingAhead`). */
  generatingAhead: number;
  generationStatus: SessionGenerationStatus;
  /** A live loop lease is holding automatic top-ups; they resume when it ends. */
  loopHeld?: boolean;
}): NewMusicStatus {
  const off = session.sessionMode === 'repeat';
  const target = session.targetDurationMinutes ?? null;
  const generated = Math.floor((session.generatedDurationSeconds ?? 0) / 60);
  const unknown = (session.unknownDurationTrackCount ?? 0) > 0;
  const generatedCount = `${generated}${unknown ? '+' : ''}`;
  const progress = target === null ? null : `${generatedCount} / ${target} min`;
  const common = {
    detail: null,
    generatedLine: progress ? `${progress} generated` : `${generatedCount} min generated so far`,
  };

  if (generatingAhead > 0 && off) {
    const text = `Finishing ${generatingAhead}`;
    return {
      ...common,
      text,
      short: text,
      sentence: `New music is off. ${generatingAhead} ${tracksWord(generatingAhead)} already started will finish, then nothing more is bought.`,
      icon: 'generating',
    };
  }
  if (generatingAhead > 0 && generationStatus !== 'worker_stalled') {
    const text = `Generating ${generatingAhead}`;
    return {
      ...common,
      text,
      short: text,
      detail: progress,
      sentence: `Buying ${generatingAhead} new ${tracksWord(generatingAhead)} right now.`,
      icon: 'generating',
    };
  }
  if (off) {
    return {
      ...common,
      text: 'New music off',
      short: 'New music off',
      sentence: 'Playing the Tracks you already have. Nothing is being bought.',
      icon: 'off',
    };
  }
  if (isDurationTargetReached(target, session.generatedDurationSeconds)) {
    return {
      ...common,
      text: `New music finished · ${generated} min`,
      short: `Done · ${generated} min`,
      sentence: `The ${target} min target is reached. Repeating, nothing more is bought.`,
      icon: 'finished',
    };
  }
  if (generationStatus === 'repeat_cost_limit') {
    return {
      ...common,
      text: 'Limit reached · Repeating',
      short: 'Limit · Repeat',
      sentence: 'Your generation limit is used up. Nothing is being bought.',
      icon: 'paused',
    };
  }
  if (generationStatus !== 'ok' && generationStatus !== 'repeat_buffer_complete') {
    return {
      ...common,
      text: 'New music paused',
      short: 'Paused',
      sentence: 'New music is on, but a problem is holding it. Nothing is being bought.',
      icon: 'paused',
    };
  }
  if (target !== null && progress !== null) {
    return {
      ...common,
      text: `${progress} generated`,
      short: progress,
      sentence: loopHeld
        ? LOOP_HOLD_SENTENCE
        : unknown
          ? 'Some audio durations are unknown. New Tracks wait until they are measured, and your music stays playable.'
          : `Nothing is being bought right now. New Tracks come when the Queue runs low, up to ${target - generated} more min, then it repeats.`,
      icon: 'target',
    };
  }
  return {
    ...common,
    text: 'New music on · no limit',
    short: 'On · no limit',
    sentence: loopHeld ? LOOP_HOLD_SENTENCE : 'Keeps buying new Tracks for as long as you listen.',
    icon: 'no-limit',
  };
}
