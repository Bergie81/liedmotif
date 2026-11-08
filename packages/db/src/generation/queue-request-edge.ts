// The queue slot ↔ generation-request join every revision-aware read shares:
// a slot's request carries the generation-time identity (styleRevision, blend
// fields), but a planned/generating slot has no track yet — so prefer the
// item's own request edge and fall back to the attached track's (they agree
// once both exist). One definition so the queue view, the buffer counters,
// and the vibe-switch cutover can never disagree on whose revision a slot has.

import { eq, sql, type SQL } from 'drizzle-orm';
import { activitySessionQueueItems, generationRequests, tracks } from '../schema';

export function queueItemRequestEdge(): SQL {
  return eq(
    generationRequests.id,
    sql`coalesce(${activitySessionQueueItems.generationRequestId}, ${tracks.generationRequestId})`,
  );
}
