// Switching New music on: Keep Going, up to a duration or with no limit. The
// mode and the target travel in one request, so the choice cannot half-apply.
// The New music sheet's Save and a card confirmed in the Assistant's chat both
// save through here.

import { setSessionDuration } from '@/lib/api-client';

/** `targetMinutes` null is No limit. */
export const switchNewMusicOn = (sessionId: string, targetMinutes: number | null) =>
  setSessionDuration(sessionId, targetMinutes, 'keep_going');
