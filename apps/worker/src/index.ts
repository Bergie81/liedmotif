// Liedmotif worker.
//
// The worker has no HTTP server. This process:
//   1. writes a liveness + readiness heartbeat file (the Docker healthcheck
//      reads it),
//   2. confirms it can reach Postgres,
//   3. confirms no other worker process owns the queue (`replica-guard.ts`),
//   4. runs the Graphile Worker job loop (bpm/key analysis, the auto-stop +
//      buffer sweep, and the buffer controller / Session Repeat) alongside the
//      heartbeat,
//   5. keeps the heartbeat fresh on an interval until shutdown.
//
// The runner assumes the `graphile_worker` schema is already installed (by
// `migrate.ts` / `db:migrate:worker`). A DB still unreachable after the boot
// retry budget, a runner that fails to start, or one that dies after starting
// all exit non-zero so Docker's restart policy retries the boot (see
// `runner-liveness.ts`); Docker never restarts a container that stays up
// unhealthy. Only a missing `DATABASE_URL` keeps the process up in a degraded
// heartbeat-only mode, reported not-ready so the healthcheck stays red.

import {
  assertDatabaseUrlPosture,
  assertNotTestDatabase,
  createDb,
  createPool,
  pingDb,
  readWorkerHeartbeat,
  reapStaleWorkerLocks,
  refreshStorageUsage,
  resolvePoolTuning,
  writeWorkerHeartbeat,
  type Database,
  type Pool,
} from '@liedmotif/db';
import { configureSharpConcurrency } from '@liedmotif/media';
import { createLogger, installProcessErrorHandlers } from '@liedmotif/shared';
import { assertStorageRootWritable, resolveStorageRuntimeConfig } from '@liedmotif/storage';
import type { Runner } from 'graphile-worker';
import { runAnalysisBootProbe } from './audio/boot-probe';
import { createDbHeartbeatWriter } from './db-heartbeat';
import { resolveHeartbeatPath, writeHeartbeat, type WorkerReadiness } from './heartbeat';
import {
  buildWorkerProviders,
  createWorkerCoverArtResolver,
  createWorkerLlmResolver,
  createWorkerMusicResolver,
  describeProviders,
  prewarmGeneratedImageProvider,
  resolveWorkerEncryptionKey,
} from './providers';
import { awaitExclusiveWorkerSlot } from './replica-guard';
import { watchRunnerLiveness } from './runner-liveness';
import { resolveWorkerConcurrency, startWorkerRunner } from './runner';
import { stopWorkerProcess } from './shutdown';

const log = createLogger({ name: 'worker' });

/** 2× headroom against the diagnostics' 30 s stale window — a cadence any
 *  faster only adds file + settings-row writes, not detection speed. */
const HEARTBEAT_INTERVAL_MS = 15_000;
const DB_RETRY_DELAY_MS = 3_000;
const DB_MAX_ATTEMPTS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ping Postgres with light retry so the worker survives DB warmup on boot. Uses
 * the shared typed Drizzle client (`pingDb`) — the same `createDb` factory the
 * web process uses — so a successful boot proves the worker's real query path,
 * not just raw socket reachability.
 */
async function waitForDatabase(db: Database): Promise<boolean> {
  for (let attempt = 1; attempt <= DB_MAX_ATTEMPTS; attempt += 1) {
    try {
      if (await pingDb(db)) {
        log.info('database reachable', { attempt });
        return true;
      }
    } catch (err) {
      log.warn('database not reachable yet', { attempt, err });
    }
    await sleep(DB_RETRY_DELAY_MS);
  }
  return false;
}

async function main(): Promise<void> {
  // Nothing else in a daemon this long-lived observes a stray rejection or a
  // throw raised outside a job: without these, both are a bare stderr stack the
  // structured logs never carry, and one of them silently restarts the container.
  installProcessErrorHandlers({
    logError: (message, fields) => log.error(message, fields),
    exit: (code) => process.exit(code),
  });
  // A few libvips threads per operation: cover finalization runs one large
  // pipeline per job slot, and an unconfigured sharp would spawn a per-core
  // pool per operation on a container this size.
  configureSharpConcurrency(2);
  const startedAt = new Date();
  const heartbeatPath = resolveHeartbeatPath();
  // Liveness begins now; readiness flips to `ready` only once the runner is up
  // (the healthcheck requires it), and to `degraded` when it never can be.
  let readiness: WorkerReadiness = 'starting';
  // The DB half of the heartbeat (diagnostics), attached once a pool exists.
  // Best-effort: it must never block or fail the file write the healthcheck needs.
  let dbHeartbeat: ((state: WorkerReadiness) => Promise<void>) | null = null;
  function publishHeartbeat(): void {
    void writeHeartbeat(heartbeatPath, readiness).catch((err) =>
      log.error('heartbeat write failed', { err }),
    );
    void dbHeartbeat?.(readiness);
  }
  // Write immediately so the healthcheck has a file before the DB is up.
  await writeHeartbeat(heartbeatPath, readiness);
  log.info('worker starting', { heartbeatPath, intervalMs: HEARTBEAT_INTERVAL_MS });

  // A ref'd interval is what keeps this daemon alive between heartbeats (there is
  // no HTTP server). Created before the runner so a fatal runner exit can always
  // stop it; shutdown clears it explicitly.
  const timer = setInterval(publishHeartbeat, HEARTBEAT_INTERVAL_MS);
  let shuttingDown = false;

  // Resolve providers through the registry (mock vs real flows from env/config),
  // never by importing a concrete vendor. The job loop consumes these below. A
  // missing music key is not a boot failure: onboarding saves it in the app.
  const providers = buildWorkerProviders();
  log.info('providers resolved', describeProviders(providers));

  // A storage root this process cannot write is a config error, so crash-fast
  // (the `main().catch` below exits non-zero and Docker restarts us). Web and
  // worker must resolve the SAME tree: when they don't, the worker's retention
  // deletes no-op against the wrong root and report success.
  await assertStorageRootWritable(resolveStorageRuntimeConfig());

  // The music pipeline encrypts provider URLs at rest; resolve the key once (a
  // present-but-invalid key fails fast here). When absent the worker still runs its
  // non-pipeline jobs — the pipeline tasks fail loudly until the key is configured.
  const encryptionKey = resolveWorkerEncryptionKey();
  if (!encryptionKey) {
    log.warn('CREDENTIAL_ENCRYPTION_KEY is not set; the music generation pipeline is disabled');
  }

  const databaseUrl = process.env.DATABASE_URL ?? '';
  let pool: Pool | undefined;
  let runner: Runner | undefined;

  /**
   * Boot failures that leave no worker running: stop the heartbeat so the
   * healthcheck goes red at once, close the pool best-effort, and exit non-zero
   * so Docker's restart policy — the only thing that restarts a container — gets
   * its chance. Staying up would look healthy while no job ever runs.
   */
  async function exitUnstarted(message: string, context: Record<string, unknown>): Promise<never> {
    log.error(message, context);
    clearInterval(timer);
    await pool?.end().catch(() => undefined);
    process.exit(1);
  }

  if (databaseUrl) {
    // Fail closed: a worker on a test database would generate paid tracks into a
    // DB the test suites truncate/drop. Config error, so crash-fast is correct.
    assertNotTestDatabase(databaseUrl);
    // Same connection string, same posture rules as the web boot: an external
    // host must speak verifying TLS, and the compose default password is called
    // out rather than quietly used.
    assertDatabaseUrlPosture(databaseUrl, log.warn);
    pool = createPool(databaseUrl, {
      applicationName: 'liedmotif-worker',
      tuning: resolvePoolTuning('worker'),
    });
    const db = createDb(pool);
    // The music, cover-image and text LLM credentials can be stored in the app, so
    // unlike the env-only providers above they resolve only once a database handle
    // exists — and lazily, per use, so a key saved in onboarding or Settings
    // applies without a restart.
    const musicResolver = createWorkerMusicResolver({
      db,
      encryptionKey,
      selection: providers.musicSelection,
    });
    const coverArtResolver = createWorkerCoverArtResolver({ db, encryptionKey });
    const llmResolver = createWorkerLlmResolver({ db, encryptionKey });
    const concurrency = resolveWorkerConcurrency();
    const reachable = await waitForDatabase(db);
    if (reachable) {
      // Exactly one worker process per database (see `replica-guard.ts`): a
      // second one races the same job rows, and the boot reap below would
      // release locks it is still executing. A crashed predecessor's heartbeat
      // ages out and this boot continues; a live peer's keeps advancing.
      const slot = await awaitExclusiveWorkerSlot({
        readHeartbeat: () => readWorkerHeartbeat(db),
        sleep,
        onWaiting: ({ pid, ageMs }) =>
          log.warn('a worker heartbeat is still live; waiting for it to age out', { pid, ageMs }),
      });
      if (slot.status === 'overlap') {
        await exitUnstarted(
          'another worker process is running against this database; refusing to start a second one',
          { pid: slot.pid },
        );
      }
      // Analysis boot probe: if this host has
      // ffmpeg, re-open any `unavailable` analyses for the backfill sweep. Log
      // loudly either way — "analysis unavailable" is a support question.
      try {
        const probe = await runAnalysisBootProbe(db);
        if (!probe.ffmpegAvailable) {
          log.warn('ffmpeg not found; track analysis will record unavailable provenance');
        } else if (probe.resetTrackIds.length > 0) {
          log.info('re-opened unavailable track analyses for reanalysis', {
            count: probe.resetTrackIds.length,
          });
        }
      } catch (err) {
        log.error('analysis boot probe failed; continuing', { err });
      }
      // The stored-byte total is otherwise only refreshed by the hourly sweep,
      // so without this the storage quota would go unenforced for up to an hour
      // after every deploy — and a fresh instance would have no figure at all.
      try {
        const { totalBytes } = await refreshStorageUsage(db);
        log.info('storage usage measured', { totalBytes });
      } catch (err) {
        log.error('storage usage measurement failed; continuing', { err });
      }
      // Clear job and queue locks a crashed predecessor left behind, BEFORE
      // this process publishes a heartbeat or starts its runner (so it holds no
      // locks of its own, and its own boot time cannot mark them live). Without
      // it, a SIGKILL/OOM pins a session's poll/download pipeline for ~4h while
      // paid provider URLs expire. Best-effort, never blocks boot.
      try {
        const { schemaPresent, jobsReaped, queuesReaped, preservedHolders } =
          await reapStaleWorkerLocks(db);
        if (!schemaPresent) {
          log.info('graphile_worker schema not installed yet; no locks to reap');
        } else if (jobsReaped > 0 || queuesReaped > 0) {
          log.warn('reaped stale worker locks left by a crashed worker', {
            jobsReaped,
            queuesReaped,
          });
        }
        if (preservedHolders > 0) {
          log.warn('left locks held by a live worker process untouched', { preservedHolders });
        }
      } catch (err) {
        log.error('stale worker-lock reap failed; continuing', { err });
      }
      dbHeartbeat = createDbHeartbeatWriter({
        write: (record) => writeWorkerHeartbeat(db, record),
        logWarn: (message, context) => log.warn(message, context),
        logInfo: (message) => log.info(message),
        concurrency,
        startedAt,
      });
      publishHeartbeat();
      try {
        runner = await startWorkerRunner({
          pgPool: pool,
          logger: log,
          db,
          getMusic: () => musicResolver.getMusic(),
          storage: providers.storage,
          encryptionKey,
          getCoverArt: () => coverArtResolver.getCoverArt(),
          getSunoCoverArt: () => musicResolver.getSunoCoverArt(),
          getLlm: () => llmResolver.getLlm(),
          concurrency,
        });
        log.info('graphile worker runner started');
        readiness = 'ready';
        publishHeartbeat();
        // A runner that dies AFTER starting means no job ever runs again while the
        // heartbeat would stay green — exit non-zero so Docker's restart policy
        // brings up a fresh worker (see runner-liveness.ts).
        watchRunnerLiveness(runner.promise, {
          isShuttingDown: () => shuttingDown,
          logError: (message, context) => log.error(message, context),
          stopHeartbeat: () => clearInterval(timer),
          closePool: () => pool?.end() ?? Promise.resolve(),
          exit: (code) => process.exit(code),
        });
        // Optional cover-art credential prewarm, OFF the readiness path: it only
        // pre-fills the provider's capability cache, and its failure only means
        // Session Covers fall back — music generation never waits on it.
        void coverArtResolver
          .getCoverArt()
          .then(async (coverArt) => {
            log.info('cover image provider resolved', {
              coverArt: coverArt?.providerKey ?? 'none',
            });
            if (!(await prewarmGeneratedImageProvider(coverArt))) {
              log.warn(
                'generated image provider validation failed; Session Covers will use fallbacks',
              );
            }
          })
          .catch((err) =>
            log.warn('cover image provider resolution failed; jobs will retry per use', { err }),
          );
        // The 'providers resolved' boot line runs before the database exists,
        // where the DB-backed credentials cannot resolve; log the real
        // resolution here, off the readiness path — jobs re-resolve per use.
        void musicResolver.getMusic().then(
          (music) => log.info('music provider resolved', { music: music.providerKey }),
          (err) =>
            log.warn('music provider is not usable yet; music jobs fail until it is', { err }),
        );
        void llmResolver.getLlm().then(
          (llm) => log.info('text llm resolved', { llm: llm?.providerKey ?? 'none' }),
          (err) => log.warn('text llm resolution failed; jobs will retry per use', { err }),
        );
      } catch (err) {
        // A runner that cannot START is the same failure class as one that dies
        // later: no job will ever run.
        await exitUnstarted('failed to start worker runner; exiting for restart', { err });
      }
    } else {
      // A DB that recovers later (slow crash recovery after a host reboot, an
      // outage outlasting the retry budget) is picked up by the restarted boot;
      // Docker's restart backoff keeps the retries from hammering it.
      await exitUnstarted('could not reach database after retries; exiting for restart', {
        attempts: DB_MAX_ATTEMPTS,
      });
    }
  } else {
    readiness = 'degraded';
    log.warn('DATABASE_URL is not set; skipping database connectivity check');
  }

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('worker shutting down', { signal });
    clearInterval(timer);
    void stopWorkerProcess({
      stopRunner: () => runner?.stop() ?? Promise.resolve(),
      closePool: () => pool?.end() ?? Promise.resolve(),
      wait: sleep,
      exit: (code) => process.exit(code),
      log: (message) => log.warn(message),
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  log.info('worker started', { readiness });
}

main().catch((err) => {
  log.error('worker failed to start', { err });
  process.exit(1);
});
