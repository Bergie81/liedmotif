// Database access for Liedmotif.
//
// Public surface: the pg connection-pool factory below, plus the typed
// Drizzle layer re-exported at the bottom — the schema (Better Auth tables), the
// `createDb` client factory, transaction helpers, and the migration runner. Web
// and worker each create their own pool (separate processes → separate pools)
// and wrap it with `createDb`; they must not share a single pool instance.

import pg from 'pg';
import type { Pool, PoolConfig } from 'pg';
import { createLogger } from '@liedmotif/shared';
import type { PoolTuning } from './pool-tuning';

export type { Pool, PoolConfig } from 'pg';

const log = createLogger({ name: 'db' });

export interface CreatePoolOptions {
  /**
   * Max clients in the pool, for the one-shot pools that carry no `tuning`
   * (migrations, seeds, scripts). Keep modest for self-hosted single-admin use.
   */
  max?: number;
  /** Postgres `application_name`, useful for distinguishing web vs worker. */
  applicationName?: string;
  /** Connection acquisition timeout in milliseconds. */
  connectionTimeoutMillis?: number;
  /** Size + session timeouts for a long-lived pool (`resolvePoolTuning(role)`). */
  tuning?: PoolTuning;
}

/**
 * The session ceilings as `pg` startup parameters, in force from the first
 * statement of every connection the pool opens.
 *
 * A zero is dropped rather than sent: `pg` skips falsy values here, so a `0`
 * would look configured while the session silently inherited the server's own
 * setting. Dropping it makes the config say what actually happens.
 */
function sessionTimeouts(tuning: PoolTuning): PoolConfig {
  return {
    ...(tuning.statementTimeoutMs > 0 ? { statement_timeout: tuning.statementTimeoutMs } : {}),
    ...(tuning.lockTimeoutMs > 0 ? { lock_timeout: tuning.lockTimeoutMs } : {}),
    ...(tuning.idleInTransactionTimeoutMs > 0
      ? { idle_in_transaction_session_timeout: tuning.idleInTransactionTimeoutMs }
      : {}),
  };
}

/**
 * Build a `pg` pool config from a connection string. Pure and unit-testable.
 *
 * Without a `tuning` the pool carries no session ceilings at all, which is what
 * the one-shot pools want — a DDL migration on a grown table outruns any
 * request-sized timeout.
 */
export function buildPoolConfig(databaseUrl: string, options: CreatePoolOptions = {}): PoolConfig {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to create a database pool');
  }
  return {
    connectionString: databaseUrl,
    max: options.tuning?.max ?? options.max ?? 10,
    application_name: options.applicationName ?? 'liedmotif',
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
    ...(options.tuning ? sessionTimeouts(options.tuning) : {}),
    // `ssl` intentionally left undefined: local/self-hosted Postgres reached over
    // the Docker Compose network. S3/managed-Postgres TLS is a later concern.
  };
}

/** Create a new connection pool. Each process should own exactly one. */
export function createPool(databaseUrl: string, options?: CreatePoolOptions): Pool {
  const pool = new pg.Pool(buildPoolConfig(databaseUrl, options));
  // An idle client losing its backend connection (Postgres restart, network
  // blip) emits 'error' on the pool; without a listener that event is fatal to
  // the Node process. Log and let the pool discard the client and reconnect.
  // A driver error can carry the connection string in its message, so only the
  // bounded name/SQLSTATE pair is logged, through the redacting logger.
  pool.on('error', (error) => {
    const code = (error as { code?: unknown }).code;
    log.error('idle pool client error; connection will be re-established', {
      errorName: error.name,
      errorCode: typeof code === 'string' ? code : null,
    });
  });
  // pg-pool drops its idle listener while a client is checked out (a
  // transaction), so a backend lost then would emit an unheard 'error' and end
  // the process. The caller's query still rejects, and the pool discards the
  // broken client on release.
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      const code = (error as { code?: unknown }).code;
      log.warn('pool client lost its connection', {
        errorName: error.name,
        errorCode: typeof code === 'string' ? code : null,
      });
    });
  });
  return pool;
}

// Per-role pool sizing + session timeouts (web and worker pass these to `createPool`).
export { resolvePoolTuning, type PoolRole, type PoolTuning } from './pool-tuning';

// Database-name safety guards (the app-side half of the app/test DB split).
export { databaseNameOf, isTestDatabaseUrl, assertNotTestDatabase } from './database-url';

// Boot posture for the connection string itself (external-host TLS, default password).
export { assertDatabaseUrlPosture } from './database-posture';

// Stored-byte accounting for the `storageQuotaBytes` ceiling.
export {
  accountedStorageBytes,
  getStorageUsage,
  isStorageQuotaReached,
  MAX_TRACK_AUDIO_BYTES,
  measureStoredBytes,
  refreshStorageUsage,
  withStorageReservation,
  type StorageUsage,
} from './storage-usage';

/** Run a trivial `SELECT 1` to confirm the database is reachable. */
export async function ping(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ ok: number }>('SELECT 1 AS ok');
  return result.rows[0]?.ok === 1;
}

// --- Typed Drizzle layer -----------------------------------------------------
// Schema (Better Auth tables), the client factory + Drizzle-level ping, and the
// transaction helpers. The programmatic migration runner is deliberately NOT
// re-exported here — it reads SQL files from disk and is a test/bootstrap tool,
// so it lives behind the `@liedmotif/db/migrate` subpath to keep the web and
// worker runtime bundles free of the migrator and its filesystem access.
export * from './schema';
export * from './credentials';
export * from './setup';
export * from './profile';
export * from './invites';
export * from './people';
export * from './voice';
// Owner-scoped user settings: the `playback`, `generation`, `coverArt`,
// `onboarding`, `assistantTone`, and (per-Member) `limits` and `assistant` keys.
export {
  completeOnboarding,
  getAssistantTone,
  getCoverArtSettings,
  getGenerationSettings,
  getMemberAssistantAccess,
  getMemberLimits,
  getOnboardingState,
  getPlaybackSettings,
  listMemberAssistantAccess,
  listMemberLimits,
  updateAssistantTone,
  updateCoverArtSettings,
  updateDefaultLanguage,
  updateGenerationSettings,
  updateMemberAssistantAccess,
  updateMemberLimits,
  updatePlaybackSettings,
} from './settings/user-settings-repo';
// The Assistant: who has it, and today's message allowance.
export { countAssistantMessage, resolveAssistantStanding } from './assistant/assistant-standing';
// Cover rows by id (pure Drizzle). The ingest/seed bootstrap — which reads
// bundled asset files — stays behind the `@liedmotif/db/seed` subpath.
export { getCoverImageById, recordCoverRenditionBytes, type CoverImageRow } from './covers/repo';
// The built-in placeholder cover's identity (row id + storage key; no asset reads).
export {
  PLACEHOLDER_COVER_ID,
  PLACEHOLDER_COVER_STORAGE_KEY,
  seedPlaceholderCover,
} from './covers/placeholder';
// Generated Session Cover writes (worker `generate-session-cover` job).
export {
  insertGeneratedCoverImage,
  replaceInitialSessionCover,
  setSessionCoverImage,
  setSessionCoverStyle,
  setSessionCoverStyleHintNormalized,
  getGeneratedCoverForSession,
  countGeneratedCoversInWindow,
  countLegacyGeneratedCoversInWindow,
  withOwnerCoverArtLock,
  acquireOwnerCoverArtLock,
  type InsertGeneratedCoverInput,
} from './covers/generated-repo';
export {
  advisoryCoverAdmission,
  countCoverSpendByOwner,
  countCoverSpendSince,
  coverAdmissionDecision,
  coverUsageView,
  getAdminCoverUsage,
  getCoverUsage,
  getCoverUsageConcurrently,
  type CoverAdmission,
  type CoverBudgetCaps,
  type CoverUsage,
} from './covers/usage';
export {
  countTaskBounds,
  lockAndResolveBudgetScopes,
  mapScopeResults,
  mapScopes,
  mapScopesConcurrently,
  resolveBudgetScopes,
  type BudgetCaps,
  type BudgetScope,
  type BudgetScopes,
  type ResolvedBudget,
} from './budget-scopes';
export { POOL_SCOPE, ownerScope, type SpendScope } from './member-pool';
export {
  ORPHAN_COVER_MIN_AGE_MS,
  ORPHAN_COVER_SWEEP_LIMIT,
  coverRenditionKey,
  listOrphanedCoverImages,
  deleteOrphanedCoverImageRows,
  type ReclaimedCover,
} from './covers/cover-reclaim';
export {
  countReservedOrPossiblyPaidCovers,
  countSessionCoverHistory,
  acquireOwnerCoverAdmissionLock,
  getSessionCoverGeneration,
  getInitialSessionCoverGeneration,
  getLatestCoverAccountOutcome,
  getLatestSessionCoverRegeneration,
  getLiveSessionCoverGeneration,
  getSessionCoverGenerationById,
  findCoverInSessionHistory,
  deleteSessionCoverFromHistory,
  listSessionCoverHistory,
  listUploadedSessionCovers,
  type DeleteSessionCoverHistoryResult,
  type UploadedCover,
  listAgedSessionCoverGenerationIds,
  listRecentSessionCoverGenerations,
  planSessionCoverGeneration,
  planReservedSessionCoverGeneration,
  reserveSessionCoverRegeneration,
  updateSessionCoverGeneration,
  withOwnerCoverAdmissionLock,
  type FrozenAttemptFields,
  type PlanSessionCoverInput,
  type PlanReservedSessionCoverInput,
  type ReserveSessionCoverRegenerationInput,
  type AgedSessionCoverGenerationId,
  type SessionCoverGenerationRow,
} from './covers/generation-ledger-repo';
// Playlist custom-cover persistence (same ledger, keyed on playlist).
export {
  countPlaylistCoverHistory,
  deletePlaylistCoverFromHistory,
  getLatestPlaylistCoverRegeneration,
  getLivePlaylistCoverGeneration,
  findCoverInPlaylistHistory,
  getPlaylistCoverHistoryEntry,
  getPlaylistCoverSubject,
  insertGeneratedPlaylistCoverImage,
  listPlaylistCoverHistory,
  listUploadedPlaylistCovers,
  reservePlaylistCoverRegeneration,
  setPlaylistCoverImage,
  setUploadedPlaylistCover,
  type DeletePlaylistCoverResult,
  type InsertGeneratedPlaylistCoverInput,
  type PlaylistCoverSubject,
  type ReservePlaylistCoverRegenerationInput,
  type SetUploadedPlaylistCoverResult,
} from './covers/playlist-cover-repo';
export {
  addUploadedSessionCover,
  type AddUploadedSessionCoverInput,
  type AddUploadedSessionCoverResult,
} from './covers/uploaded-session-cover-repo';
// Generation-controller query layer: track/limit/session/eviction/reroll reads
// + writes for the worker buffer controller.
export * from './generation';
export * from './analytics';
export * from './playlists';
export * from './offline';
export * from './search';
// Worker diagnostics: the heartbeat record + instance-wide status reads.
export * from './worker';
// Append-only event-table retention (per-table decision + the bounded prune).
export * from './retention';
export { createDb, pingDb, type Database, type Schema } from './client';
export {
  withTransaction,
  withRetryableTransaction,
  isRetryableTransactionError,
  type Transaction,
  type DbOrTx,
  type RetryableTransactionOptions,
} from './transactions';
