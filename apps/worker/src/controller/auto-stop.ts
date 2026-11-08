// Pure auto-stop classification: a low-frequency sweep uses
// this to decide whether an ACTIVE session should move to `stopped`. Only idle
// time stops one. A cost limit or a Session duration target never does — both
// gate generation into Session Repeat inside the buffer controller, and the
// listener keeps playing.
//
// `maxSessionMinutesWithoutConfirmation` would land here and is deliberately
// unwired: enforcing it would hard-stop a session someone is actively
// listening to.

import type { SessionEndReason } from '@liedmotif/shared';

export interface AutoStopSessionInput {
  status: 'active' | 'stopped';
  startedAt: Date;
  lastResumedAt: Date | null;
  lastPlaybackReportAt: Date | null;
  idleAutoStopAfterMinutes: number;
}

/** A reason to auto-stop, or null to leave the session active. */
export type AutoStopDecision = {
  endReason: Extract<SessionEndReason, 'idle_timeout'>;
} | null;

const MS_PER_MINUTE = 60_000;

/** The start of the session's current active span (Resume restarts the idle baseline). */
function activeSpanStart(session: AutoStopSessionInput): Date {
  return session.lastResumedAt ?? session.startedAt;
}

export function classifyAutoStop(session: AutoStopSessionInput, now: Date): AutoStopDecision {
  // Only an active session can auto-stop; a stopped one is already terminal here.
  if (session.status !== 'active') return null;

  const spanStart = activeSpanStart(session).getTime();

  // Idle: no playback report within the window. A report from before the span
  // started (the previous listen of a resumed session) never counts against it.
  const idleSince = Math.max(session.lastPlaybackReportAt?.getTime() ?? 0, spanStart);
  if (now.getTime() - idleSince >= session.idleAutoStopAfterMinutes * MS_PER_MINUTE) {
    return { endReason: 'idle_timeout' };
  }

  return null;
}
