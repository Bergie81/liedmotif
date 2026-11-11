import { describe, expect, it } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
import { mockMusicProvider } from '@liedmotif/providers';
import { createLogger } from '@liedmotif/shared';
import {
  buildTaskList,
  createGraphileLogger,
  RECURRING_CRONTAB,
  withQueryParamsRedacted,
  WORKER_TASK_IDENTIFIERS,
  type WorkerRunnerDeps,
} from './runner';

// The runner wiring is boot glue; assert it registers every job (incl. the provider readiness
// pipeline) and schedules the recurring ones. Running the runner itself needs a live
// `graphile_worker` schema, which this unit test does not have.
const deps: WorkerRunnerDeps = {
  db: {} as WorkerRunnerDeps['db'],
  getMusic: async () => mockMusicProvider(),
  storage: {} as WorkerRunnerDeps['storage'],
  fetchImpl: globalThis.fetch,
  encryptionKey: null,
  getCoverArt: async () => null,
  getSunoCoverArt: async () => null,
};

describe('worker runner registry', () => {
  it('registers a handler for every declared task identifier', () => {
    const taskList = buildTaskList(deps);
    for (const id of WORKER_TASK_IDENTIFIERS) {
      expect(typeof taskList[id]).toBe('function');
    }
    expect(Object.keys(taskList).sort()).toEqual([...WORKER_TASK_IDENTIFIERS].sort());
  });

  it('schedules the recurring sweep + deletion-queue + analysis-backfill jobs', () => {
    expect(RECURRING_CRONTAB).toContain('sweep-active-sessions');
    expect(RECURRING_CRONTAB).toContain('process-deletion-queue');
    expect(RECURRING_CRONTAB).toContain('finish-deferred-session-deletes');
    expect(RECURRING_CRONTAB).toContain('backfill-track-analysis');
    expect(RECURRING_CRONTAB).toContain('retry-saved-downloads');
    expect(RECURRING_CRONTAB).toContain('salvage-timed-out-finals');
    // Every cron line references a registered task.
    const scheduledTasks = RECURRING_CRONTAB.split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('#'))
      .map((line) => line.trim().split(/\s+/).pop());
    for (const task of scheduledTasks) {
      expect(WORKER_TASK_IDENTIFIERS).toContain(task);
    }
  });
});

describe('graphile logger', () => {
  it("keeps a failed task's Drizzle query params (user prompts) out of the log", () => {
    const lines: string[] = [];
    const logger = createGraphileLogger(createLogger({ sink: (line) => lines.push(line) }));
    const err = new DrizzleQueryError(
      'insert into "generation_requests" ("user_id", "user_prompt") values ($1, $2)',
      ['user-1', 'PRIVATE-PROMPT my therapist said\nsecond line'],
      new Error('connection terminated'),
    );
    // Graphile's failed-task line: the message and the indented stack, inlined.
    logger.error(
      `Failed task 7 (ensure-session-buffer, 3.00ms, attempt 1 of 25) with error '${err.message}':\n  ${String(err.stack).replace(/\n/g, '\n  ').trim()}`,
      { failure: true, error: err },
    );

    const out = lines.join('\n');
    expect(out).toContain('Failed task 7 (ensure-session-buffer');
    expect(out).toContain('Failed query: insert into');
    expect(out).not.toContain('PRIVATE-PROMPT');
    expect(out).not.toContain('second line');
  });
});

describe('failed-task errors', () => {
  it("rethrows a task's Drizzle query error without its params, so `last_error` never stores them", async () => {
    const err = new DrizzleQueryError(
      'insert into "generation_requests" ("user_id", "user_prompt") values ($1, $2)',
      ['user-1', 'PRIVATE-PROMPT my therapist said\nsecond line'],
      new Error('connection terminated'),
    );
    const tasks = withQueryParamsRedacted({
      'ensure-session-buffer': async () => {
        throw err;
      },
    });

    const thrown = (await Promise.resolve(tasks['ensure-session-buffer']!({}, {} as never)).catch(
      (e: unknown) => e,
    )) as Error;

    expect(thrown).toBe(err);
    expect(thrown.message).toBe(
      'Failed query: insert into "generation_requests" ("user_id", "user_prompt") values ($1, $2)\nparams: [REDACTED]',
    );
    expect(String(thrown.stack)).not.toContain('PRIVATE-PROMPT');
    expect(String(thrown.stack)).not.toContain('second line');
  });
});
