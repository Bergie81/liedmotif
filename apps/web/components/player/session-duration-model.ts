import { isDurationTargetReached, type SessionSummary } from '@liedmotif/shared';

type DurationProgress = Pick<
  SessionSummary,
  'targetDurationMinutes' | 'generatedDurationSeconds' | 'unknownDurationTrackCount'
>;

export function isSessionDurationReached(session: DurationProgress): boolean {
  return isDurationTargetReached(session.targetDurationMinutes, session.generatedDurationSeconds);
}

export function sessionDurationLabel(session: DurationProgress): string | null {
  if (session.targetDurationMinutes == null) return null;
  const minutes = Math.floor((session.generatedDurationSeconds ?? 0) / 60);
  const unknown = (session.unknownDurationTrackCount ?? 0) > 0;
  const progress = `${minutes}${unknown ? '+' : ''} / ${session.targetDurationMinutes} min`;
  if (isSessionDurationReached(session)) return `${progress} · Repeating`;
  return unknown ? `${progress} · Duration unknown` : `${progress} generated`;
}
