'use client';

import { Timer } from 'lucide-react';
import type { SessionSummary } from '@liedmotif/shared';
import { isSessionDurationReached, sessionDurationLabel } from './session-duration-model';

export function SessionDurationProgress({
  session,
  onEdit,
}: {
  session: SessionSummary;
  onEdit: () => void;
}) {
  const label = sessionDurationLabel(session);
  if (!label) return null;
  const durationBlocked =
    (session.unknownDurationTrackCount ?? 0) > 0 && !isSessionDurationReached(session);
  return (
    <button
      type="button"
      title={
        durationBlocked
          ? 'Some audio durations are unknown. New generation waits for measurement; existing music stays playable.'
          : undefined
      }
      className="inline-flex min-h-[42px] items-center gap-2 text-[11px] text-muted"
      onClick={onEdit}
      aria-label={`Edit Session duration: ${label}`}
    >
      <Timer className="h-4 w-4 shrink-0" aria-hidden />
      <span>
        {label}
        {durationBlocked ? (
          <span className="block text-[10px]">Generation waits; music stays playable.</span>
        ) : null}
      </span>
    </button>
  );
}
