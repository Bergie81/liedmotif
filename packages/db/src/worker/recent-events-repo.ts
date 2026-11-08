// The diagnostics "Recent events" feed, DERIVED read-only from the domain
// tables — deliberately no `worker_events` table, no new write paths (research
// decision). What the tables can't reconstruct (per-retry backoff, buffer
// ticks) stays out until a real event ledger earns its place.
//
// HARD RULE (design): events carry ids and timings only — never keys, signed
// URLs, provider URLs, or prompt text. Only columns that are safe by
// construction are selected here (`error_message_safe` is sanitized at write
// time); the web layer renders the strings.

import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { DbOrTx } from '../transactions';
import { generationRequests, providerJobs, trackAudioAssets } from '../schema';

export type WorkerEvent =
  | {
      kind: 'generation_failed';
      at: Date;
      /** The generation request id. */
      id: string;
      errorCode: string | null;
      safeMessage: string | null;
    }
  | {
      kind: 'provider_submitted';
      at: Date;
      /** The provider's own task id. */
      id: string;
    }
  | {
      kind: 'track_downloaded';
      at: Date;
      /** The track id. */
      id: string;
      byteSize: number | null;
      durationSeconds: number | null;
    };

/** Terminal generation failures — the only warn-level source. */
async function failureEvents(db: DbOrTx, limit: number): Promise<WorkerEvent[]> {
  const rows = await db
    .select({
      at: generationRequests.updatedAt,
      id: generationRequests.id,
      errorCode: generationRequests.errorCode,
      safeMessage: generationRequests.errorMessageSafe,
    })
    .from(generationRequests)
    .where(eq(generationRequests.status, 'failed'))
    .orderBy(desc(generationRequests.updatedAt))
    .limit(limit);
  return rows.map((row) => ({ kind: 'generation_failed', ...row }));
}

/** Jobs that reached the provider; both selected columns are pinned non-null by the filter. */
async function submissionEvents(db: DbOrTx, limit: number): Promise<WorkerEvent[]> {
  const rows = await db
    .select({ at: providerJobs.lastSubmitAttemptAt, id: providerJobs.providerTaskId })
    .from(providerJobs)
    .where(and(isNotNull(providerJobs.lastSubmitAttemptAt), isNotNull(providerJobs.providerTaskId)))
    .orderBy(desc(providerJobs.lastSubmitAttemptAt))
    .limit(limit);
  return rows.map((row) => ({ kind: 'provider_submitted', at: row.at!, id: row.id! }));
}

/** Audio stored locally — provider-side assets (stream URLs) are not downloads. */
async function downloadEvents(db: DbOrTx, limit: number): Promise<WorkerEvent[]> {
  const rows = await db
    .select({
      at: trackAudioAssets.createdAt,
      id: trackAudioAssets.trackId,
      byteSize: trackAudioAssets.byteSize,
      durationSeconds: trackAudioAssets.durationSeconds,
    })
    .from(trackAudioAssets)
    .where(
      and(eq(trackAudioAssets.assetType, 'local_original'), isNotNull(trackAudioAssets.storageKey)),
    )
    .orderBy(desc(trackAudioAssets.createdAt))
    .limit(limit);
  return rows.map((row) => ({ kind: 'track_downloaded', ...row }));
}

/** The newest `limit` events across all sources, newest first. */
export async function getRecentWorkerEvents(db: DbOrTx, limit = 20): Promise<WorkerEvent[]> {
  // Each source is capped at `limit` before the merge, so the merged cap holds
  // no matter how lopsided the sources are.
  const sources = await Promise.all([
    failureEvents(db, limit),
    submissionEvents(db, limit),
    downloadEvents(db, limit),
  ]);
  return sources
    .flat()
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, limit);
}
