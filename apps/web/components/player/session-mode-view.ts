import type { SessionMode } from '@liedmotif/shared';

/** Exhaustive over `SessionMode`: a new mode cannot ship without its wording. */
export const SESSION_MODE_LABEL: Record<SessionMode, string> = {
  keep_going: 'Generate new Tracks',
  repeat: 'Play existing Tracks',
};
