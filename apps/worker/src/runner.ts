// The Graphile Worker job loop. Assembles the task list from the job factories and
// runs the runner against the SHARED worker pool, alongside the liveness heartbeat in
// `index.ts`. The `graphile_worker` schema is installed out-of-band by `migrate.ts`
// (we never self-install on boot — see that file), so the runner assumes the schema
// exists.
//
// The provider readiness pipeline runs behind the music-provider interface:
// `ensure-session-buffer` submits → `poll-music-generation` polls (free) →
// `process-provider-results` materializes tracks/encrypted assets/queue items →
// `download-final-audio` lands local bytes → the existing `analyze-track-bpm-key`.
// `poll-due-provider-jobs` is the recurring safety net for a lost poll reschedule.
// `process-deletion-queue` closes the retention loop: it deletes the audio files
// that dislike-reject and session deletion queued in `deletion_queue_items`.

import type { Database, Pool } from '@liedmotif/db';
import type {
  GeneratedImageProvider,
  LlmProvider,
  MusicProvider,
  PinnedFetch,
} from '@liedmotif/providers';
import { REDACTED, type Logger as AppLogger } from '@liedmotif/shared';
import type { StorageProvider } from '@liedmotif/storage';
import { Logger, run, type Runner, type TaskList } from 'graphile-worker';
import { createWorkerTrackAnalyzer } from './audio/track-analyzer';
import { createAnalyzeTrackBpmKeyTask } from './jobs/analyze-track-bpm-key';
import { createBackfillTrackAnalysisTask } from './jobs/backfill-track-analysis';
import { createDownloadFinalAudioTask } from './jobs/download-final-audio';
import { createEmbedTrackMetadataTask } from './jobs/embed-track-metadata';
import { createFinishDeferredSessionDeletesTask } from './jobs/finish-deferred-session-deletes';
import { createGeneratePlaylistCoverTask } from './jobs/generate-playlist-cover';
import { createGenerateSessionCoverTask } from './jobs/generate-session-cover';
import { createEnsureSessionBufferTask } from './jobs/ensure-session-buffer';
import { createPollDueProviderJobsTask } from './jobs/poll-due-provider-jobs';
import { createPollMusicGenerationTask } from './jobs/poll-music-generation';
import { createProcessDeletionQueueTask } from './jobs/process-deletion-queue';
import { createProcessProviderResultsTask } from './jobs/process-provider-results';
import { createPruneEventTablesTask } from './jobs/prune-event-tables';
import { createRecoverSessionCoversTask } from './jobs/recover-session-covers';
import { createRetrySavedDownloadsTask } from './jobs/retry-saved-downloads';
import { createSalvageTimedOutFinalsTask } from './jobs/salvage-timed-out-finals';
import { createSweepActiveSessionsTask } from './jobs/sweep-active-sessions';
import { createSweepOrphansTask } from './jobs/sweep-orphans';

export interface WorkerRunnerDeps {
  db: Database;
  /** The music provider, resolved per job run (see `createWorkerMusicResolver`). */
  getMusic: () => Promise<MusicProvider>;
  storage: StorageProvider;
  /**
   * Transport for provider-returned media, injected so the download fetch is
   * testable and never hits a real network in tests. Unset in production: the
   * egress guard then dials only the addresses it vetted.
   */
  fetchImpl?: PinnedFetch;
  /** AES-256-GCM master key for provider-URL encryption, or null when unconfigured. */
  encryptionKey: Buffer | null;
  /** Prompt-driven generated-cover provider per job run, or null while no key resolves. */
  getCoverArt: () => Promise<GeneratedImageProvider | null>;
  /** Music-task-driven Suno cover source per job run, or null when unbuildable. */
  getSunoCoverArt: () => Promise<GeneratedImageProvider | null>;
  /** Resolve the optional text LLM; omitted means "no LLM". */
  getLlm?: () => Promise<LlmProvider | null>;
}

/** The registered task identifiers, exported so tests/tooling can assert coverage. */
export const WORKER_TASK_IDENTIFIERS = [
  'analyze-track-bpm-key',
  'backfill-track-analysis',
  'ensure-session-buffer',
  'sweep-active-sessions',
  'poll-music-generation',
  'process-provider-results',
  'download-final-audio',
  'retry-saved-downloads',
  'salvage-timed-out-finals',
  'poll-due-provider-jobs',
  'process-deletion-queue',
  'finish-deferred-session-deletes',
  'sweep-orphans',
  'prune-event-tables',
  'generate-session-cover',
  'generate-playlist-cover',
  'recover-session-covers',
  'embed-track-metadata',
] as const;

/**
 * Recurring jobs (Graphile crontab syntax). The sweep runs every minute (auto-stop
 * + buffer safety-net for sleeping phones); the poll safety-net scans for overdue
 * in-flight jobs every minute; the deletion-queue drain runs every minute (cheap
 * indexed scan — it usually finds nothing, but keeps `/data` reclamation prompt
 * and retries failed deletes). Comments/blank lines are ignored by the parser.
 */
export const RECURRING_CRONTAB = [
  '# Auto-stop idle/bounded sessions + buffer top-up safety net (every minute)',
  '* * * * * sweep-active-sessions',
  '# Re-enqueue polls for in-flight provider jobs whose poll loop stalled, and the',
  '# materialization recovery for recent ready jobs missing tracks (every minute)',
  '* * * * * poll-due-provider-jobs',
  '# Drain due deletion_queue_items: actually delete queued audio files (every minute)',
  '* * * * * process-deletion-queue',
  '# Finish Delete Sessions that waited on in-flight generation work (every minute)',
  '* * * * * finish-deferred-session-deletes',
  '# Rate-limited analysis backfill/reanalysis for ready finals (every 5 minutes)',
  '*/5 * * * * backfill-track-analysis',
  '# Reclaim orphaned tracks and unreferenced cover art (safety net, hourly)',
  '0 * * * * sweep-orphans',
  '# Retry the given-up final download of Saved tracks still within provider retention (hourly)',
  '30 * * * * retry-saved-downloads',
  '# Attach late provider finals to stream-only tracks of timed-out jobs (every 5 minutes)',
  '*/5 * * * * salvage-timed-out-finals',
  '# Apply the append-only event tables’ retention horizons (daily, off-peak)',
  '20 3 * * * prune-event-tables',
  '# Resume aged Session Cover operations through the single deep seam (every minute)',
  '* * * * * recover-session-covers',
].join('\n');

/** Build the Graphile task list, binding each job factory to the live deps. */
export function buildTaskList(deps: WorkerRunnerDeps): TaskList {
  return withQueryParamsRedacted({
    'analyze-track-bpm-key': createAnalyzeTrackBpmKeyTask({
      db: deps.db,
      // The REAL analyzer: staging from the injected storage, ffmpeg
      // loudness, and the anchored tempo estimator in a worker thread.
      analyzer: createWorkerTrackAnalyzer({ storage: deps.storage }),
    }),
    'backfill-track-analysis': createBackfillTrackAnalysisTask({
      db: deps.db,
      storage: deps.storage,
    }),
    'ensure-session-buffer': createEnsureSessionBufferTask({
      db: deps.db,
      getMusic: deps.getMusic,
      ...(deps.getLlm ? { getLlm: deps.getLlm } : {}),
    }),
    'sweep-active-sessions': createSweepActiveSessionsTask({ db: deps.db }),
    'poll-music-generation': createPollMusicGenerationTask({
      db: deps.db,
      getMusic: deps.getMusic,
      encryptionKey: deps.encryptionKey,
    }),
    'process-provider-results': createProcessProviderResultsTask({
      db: deps.db,
      getMusic: deps.getMusic,
      encryptionKey: deps.encryptionKey,
    }),
    'download-final-audio': createDownloadFinalAudioTask({
      db: deps.db,
      storage: deps.storage,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      encryptionKey: deps.encryptionKey,
    }),
    'retry-saved-downloads': createRetrySavedDownloadsTask({ db: deps.db }),
    'salvage-timed-out-finals': createSalvageTimedOutFinalsTask({
      db: deps.db,
      getMusic: deps.getMusic,
      encryptionKey: deps.encryptionKey,
    }),
    'poll-due-provider-jobs': createPollDueProviderJobsTask({ db: deps.db }),
    'process-deletion-queue': createProcessDeletionQueueTask({
      db: deps.db,
      storage: deps.storage,
    }),
    'finish-deferred-session-deletes': createFinishDeferredSessionDeletesTask({ db: deps.db }),
    'sweep-orphans': createSweepOrphansTask({
      db: deps.db,
      storage: deps.storage,
    }),
    'prune-event-tables': createPruneEventTablesTask({ db: deps.db }),
    'generate-session-cover': createGenerateSessionCoverTask({
      db: deps.db,
      getCoverArt: deps.getCoverArt,
      getSunoCoverArt: deps.getSunoCoverArt,
      storage: deps.storage,
    }),
    'generate-playlist-cover': createGeneratePlaylistCoverTask({
      db: deps.db,
      getCoverArt: deps.getCoverArt,
      storage: deps.storage,
    }),
    'recover-session-covers': createRecoverSessionCoversTask({
      db: deps.db,
      getCoverArt: deps.getCoverArt,
      getSunoCoverArt: deps.getSunoCoverArt,
      storage: deps.storage,
    }),
    'embed-track-metadata': createEmbedTrackMetadataTask({
      db: deps.db,
      storage: deps.storage,
    }),
  });
}

/**
 * Graphile persists a failed task's raw `error.message` as the job's
 * `last_error` (in the database and every backup), past the logger's
 * redaction. A Drizzle query error's message carries the bound params (user
 * prompts), so it is rebuilt from the SQL alone before Graphile sees it — the
 * stack too, whose first line repeats the message.
 */
export function withQueryParamsRedacted(tasks: TaskList): TaskList {
  const wrapped: TaskList = {};
  for (const [name, task] of Object.entries(tasks)) {
    if (!task) continue;
    wrapped[name] = async (payload, helpers) => {
      try {
        return await task(payload, helpers);
      } catch (err) {
        const query = (err as { query?: unknown }).query;
        if (err instanceof Error && typeof query === 'string' && 'params' in err) {
          const safe = `Failed query: ${query}\nparams: ${REDACTED}`;
          if (typeof err.stack === 'string') err.stack = err.stack.split(err.message).join(safe);
          err.message = safe;
        }
        throw err;
      }
    };
  }
  return wrapped;
}

/**
 * Graphile's own log lines routed through the app logger, so they get its
 * redaction. A failed task's line inlines the error's message and stack, and a
 * Drizzle query error's message carries the bound params (user prompts): the
 * line is cut where the error text begins and the error travels as a field,
 * where the redactor drops the params.
 */
export function createGraphileLogger(log: AppLogger): Logger {
  return new Logger((scope) => (level, message, meta) => {
    const { error, job: _job, ...rest } = meta ?? {};
    let msg = message;
    if (error instanceof Error && error.message) {
      const at = message.indexOf(error.message);
      if (at >= 0) msg = message.slice(0, at).replace(/ with error '$/, '');
    }
    const fields = { ...scope, ...rest, ...(error === undefined ? {} : { err: error }) };
    if (level === 'error') log.error(msg, fields);
    else if (level === 'warning') log.warn(msg, fields);
    else if (level === 'info') log.info(msg, fields);
    else log.debug(msg, fields);
  });
}

export interface StartWorkerRunnerOptions extends WorkerRunnerDeps {
  pgPool: Pool;
  /** Receives Graphile's own log lines (task failures, cron, worker lifecycle). */
  logger: AppLogger;
  /** Max jobs in flight; defaults to `DEFAULT_WORKER_CONCURRENCY`. */
  concurrency?: number;
}

export const DEFAULT_WORKER_CONCURRENCY = 2;
/** Anything above this reads as a misconfiguration, not an intent. */
const MAX_WORKER_CONCURRENCY = 16;

/**
 * Runner concurrency from `WORKER_CONCURRENCY`; unset, unparseable, or outside
 * 1–16 falls back to the default. A config value, not a spend control: paid
 * provider submissions stay governed by the database admission/idempotency locks
 * regardless of how many job slots run.
 */
export function resolveWorkerConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.WORKER_CONCURRENCY?.trim() ?? '', 10);
  if (Number.isNaN(parsed) || parsed < 1 || parsed > MAX_WORKER_CONCURRENCY) {
    return DEFAULT_WORKER_CONCURRENCY;
  }
  return parsed;
}

/**
 * Start the Graphile runner on the shared worker pool. `noHandleSignals` is set so
 * the worker's `main()` owns shutdown (it stops the runner before closing the pool).
 */
export async function startWorkerRunner(options: StartWorkerRunnerOptions): Promise<Runner> {
  return run({
    pgPool: options.pgPool,
    concurrency: options.concurrency ?? DEFAULT_WORKER_CONCURRENCY,
    noHandleSignals: true,
    logger: createGraphileLogger(options.logger),
    taskList: buildTaskList({
      db: options.db,
      getMusic: options.getMusic,
      storage: options.storage,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      encryptionKey: options.encryptionKey,
      getCoverArt: options.getCoverArt,
      getSunoCoverArt: options.getSunoCoverArt,
      ...(options.getLlm ? { getLlm: options.getLlm } : {}),
    }),
    crontab: RECURRING_CRONTAB,
  });
}
