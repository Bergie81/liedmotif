import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { encryptedBackupStream } from '../apps/web/lib/backup-download';

/**
 * `docker/backup.sh --once`: one check of the backup sidecar, against a stubbed
 * `psql` (the due row `docker/backup-due.sql` would return) and `pg_dump`.
 *
 * Run under `bash`, not `sh`: the script needs `pipefail` (a failed `pg_dump`
 * must not exit 0 through `gzip`), which the container's busybox `ash` has and
 * Debian's `dash` does not.
 */
const BACKUP_SCRIPT = fileURLToPath(new URL('./backup.sh', import.meta.url));

const BACKUP_NAME = /^liedmotif-backup-\d{8}T\d{6}Z$/;

/** UTC, whole seconds: the format the sidecar and the due query use. */
function isoSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

interface DueRow {
  enabled: boolean;
  frequency: 'daily' | 'weekly';
  keep: number;
  includeMedia: boolean;
  requestedAt: string | null;
  lastSlot: string;
  nextSlot: string;
}

/** A weekly schedule whose last slot was an hour ago. */
function dueRow(overrides: Partial<DueRow> = {}): DueRow {
  return {
    enabled: true,
    frequency: 'weekly',
    keep: 4,
    includeMedia: true,
    requestedAt: null,
    lastSlot: isoSeconds(Date.now() - HOUR_MS),
    nextSlot: isoSeconds(Date.now() + 6 * DAY_MS),
    ...overrides,
  };
}

interface Sidecar {
  backups: string;
  data: string;
  /** What `psql` answers for the due query; `null` makes it fail like an unreachable database. */
  setDue: (row: DueRow | null) => Promise<void>;
  /** What `df` reports free on the backups volume, instead of the real disk. */
  setFreeBytes: (bytes: number) => Promise<void>;
  failDump: () => Promise<void>;
  dumps: () => Promise<number>;
  run: (...args: string[]) => Promise<{ code: number | null; output: string }>;
  folders: () => Promise<string[]>;
  status: () => Promise<Record<string, unknown>>;
  manifest: (folder: string) => Promise<Record<string, unknown>>;
  /** A complete backup from an earlier run, at `stamp` (e.g. `20000101T000000Z`). */
  seedBackup: (stamp: string) => Promise<string>;
  /** `status.json` as the last `pg_dump` found it. */
  statusDuringDump: () => Promise<Record<string, unknown>>;
}

async function sidecar(env: Record<string, string> = {}): Promise<Sidecar> {
  const root = await mkdtemp(join(tmpdir(), 'liedmotif-backup-'));
  const bin = join(root, 'bin');
  const backups = join(root, 'backups');
  const data = join(root, 'data');
  await Promise.all([mkdir(bin), mkdir(backups), mkdir(data)]);

  const dueFile = join(root, 'due');
  const dumpsFile = join(root, 'dumps');
  const dumpFailsFile = join(root, 'dump-fails');
  const statusDuringDumpFile = join(root, 'status-during-dump');

  // Like the real tools, both name the server they could not reach.
  await writeFile(
    join(bin, 'psql'),
    `#!/bin/sh
if [ ! -f '${dueFile}' ]; then
  echo "psql: error: connection to server at \\"$PGHOST\\" failed for user \\"$PGUSER\\"" >&2
  exit 2
fi
cat '${dueFile}'
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, 'pg_dump'),
    `#!/bin/sh
echo dump >>'${dumpsFile}'
cp '${backups}/status.json' '${statusDuringDumpFile}'
if [ -f '${dumpFailsFile}' ]; then
  echo "pg_dump: error: connection to server at \\"$PGHOST\\" failed for user \\"$PGUSER\\"" >&2
  exit 1
fi
echo '-- PostgreSQL database dump'
`,
    { mode: 0o755 },
  );

  const sidecarEnv = {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    BACKUP_DIR: backups,
    MEDIA_DIR: data,
    BACKUP_ENCRYPTION_PASSPHRASE: '',
    ...env,
  };

  return {
    backups,
    data,
    setDue: async (row) => {
      if (row === null) {
        await rm(dueFile, { force: true });
        return;
      }
      const flag = (value: boolean) => (value ? 't' : 'f');
      await writeFile(
        dueFile,
        [
          flag(row.enabled),
          row.frequency,
          0,
          3,
          row.keep,
          flag(row.includeMedia),
          'UTC',
          row.requestedAt ?? '',
          row.lastSlot,
          row.nextSlot,
        ].join('|') + '\n',
      );
    },
    setFreeBytes: (bytes) =>
      writeFile(
        join(bin, 'df'),
        `#!/bin/sh
echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'
echo 'stub 0 0 ${bytes / 1024} 0% /'
`,
        { mode: 0o755 },
      ),
    failDump: () => writeFile(dumpFailsFile, ''),
    dumps: async () => {
      const raw = await readFile(dumpsFile, 'utf8').catch(() => '');
      return raw.split('\n').filter(Boolean).length;
    },
    run: (...args) => runScript(sidecarEnv, args.length ? args : ['--once']),
    folders: async () => (await readdir(backups)).filter((name) => BACKUP_NAME.test(name)).sort(),
    status: async () => JSON.parse(await readFile(join(backups, 'status.json'), 'utf8')),
    manifest: async (folder) =>
      JSON.parse(await readFile(join(backups, folder, 'manifest.json'), 'utf8')),
    statusDuringDump: async () => JSON.parse(await readFile(statusDuringDumpFile, 'utf8')),
    seedBackup: async (stamp) => {
      const folder = `liedmotif-backup-${stamp}`;
      await mkdir(join(backups, folder));
      await writeFile(join(backups, folder, 'db.sql.gz'), 'old dump');
      await writeFile(join(backups, folder, 'manifest.json'), JSON.stringify({ format: 1 }));
      return folder;
    },
  };
}

/** Resolves once the wall clock has moved past the second `iso` names. */
async function secondAfter(iso: string): Promise<string> {
  const next = Date.parse(iso) + 1000;
  while (Date.now() < next) await new Promise((resolve) => setTimeout(resolve, 50));
  return isoSeconds(Date.now());
}

describe('backup sidecar', () => {
  it('makes one complete backup folder when there has never been one', async () => {
    const box = await sidecar();
    await writeFile(join(box.data, 'track.mp3'), 'audio');
    const row = dueRow();
    await box.setDue(row);

    await box.run();

    const folders = await box.folders();
    expect(folders).toHaveLength(1);
    const [folder] = folders;
    expect(await readdir(join(box.backups, folder)).then((names) => names.sort())).toEqual([
      'db.sql.gz',
      'manifest.json',
      'media',
    ]);
    expect(await readFile(join(box.backups, folder, 'media', 'track.mp3'), 'utf8')).toBe('audio');

    const manifest = await box.manifest(folder);
    expect(manifest).toEqual({
      format: 1,
      createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
      trigger: 'schedule',
      encrypted: false,
      includesMedia: true,
      dbBytes: (await stat(join(box.backups, folder, 'db.sql.gz'))).size,
      mediaBytes: 5,
      mediaFiles: 1,
    });
    expect(folder).toBe(`liedmotif-backup-${String(manifest.createdAt).replace(/[-:]/g, '')}`);

    expect(await box.status()).toEqual({
      checkedAt: expect.any(String),
      nextRunAt: row.nextSlot,
      running: null,
      lastAttempt: { startedAt: manifest.createdAt, finishedAt: expect.any(String), ok: true },
      lastSuccessAt: manifest.createdAt,
      overdue: false,
      diskBytes: expect.any(Number),
      freeBytes: expect.any(Number),
      encrypted: false,
    });
  });

  it('only refreshes its status when nothing is due', async () => {
    const box = await sidecar();
    await box.setDue(dueRow({ enabled: false }));
    const before = isoSeconds(Date.now());

    await box.run();

    expect(await box.dumps()).toBe(0);
    expect(await box.folders()).toEqual([]);
    const status = await box.status();
    expect(String(status.checkedAt) >= before).toBe(true);
    expect(status).toMatchObject({
      nextRunAt: null,
      lastAttempt: null,
      lastSuccessAt: null,
      overdue: false,
    });
  });

  it('makes no second backup when it restarts within the period of a success', async () => {
    const box = await sidecar();
    await box.setDue(dueRow());

    await box.run();
    await box.run();

    expect(await box.dumps()).toBe(1);
    expect(await box.folders()).toHaveLength(1);
  });

  it('runs a Back up now request once, even with the schedule off', async () => {
    const box = await sidecar();
    await box.setDue(dueRow({ enabled: false, requestedAt: isoSeconds(Date.now()) }));

    await box.run();
    await box.run();

    const folders = await box.folders();
    expect(folders).toHaveLength(1);
    expect(await box.manifest(folders[0])).toMatchObject({ trigger: 'manual' });
    expect(await box.dumps()).toBe(1);
  });

  it('keeps the newest backups up to the keep count and clears crashed runs', async () => {
    const box = await sidecar();
    await box.seedBackup('20000101T000000Z');
    await box.seedBackup('20000102T000000Z');
    const newestSeed = await box.seedBackup('20000103T000000Z');
    await mkdir(join(box.backups, '.partial-20000104T000000Z'));
    await box.setDue(dueRow({ keep: 2 }));

    await box.run();

    const folders = await box.folders();
    expect(folders).toHaveLength(2);
    expect(folders[0]).toBe(newestSeed);
    expect((await readdir(box.backups)).filter((name) => name.startsWith('.partial-'))).toEqual([]);
  });

  it('keeps every older backup when the dump fails, and leaves no folder behind', async () => {
    const box = await sidecar();
    const seeds = [
      await box.seedBackup('20000101T000000Z'),
      await box.seedBackup('20000102T000000Z'),
    ];
    await box.setDue(dueRow({ keep: 1 }));
    await box.failDump();

    await box.run();

    expect(await box.folders()).toEqual(seeds);
    expect((await readdir(box.backups)).filter((name) => name.startsWith('.partial-'))).toEqual([]);
    expect(await box.status()).toMatchObject({
      lastAttempt: { ok: false, error: 'dump-failed' },
      lastSuccessAt: '2000-01-02T00:00:00Z',
    });
  });

  it('shares unchanged media between consecutive backups and copies what changed', async () => {
    const box = await sidecar();
    await writeFile(join(box.data, 'kept.mp3'), 'same audio');
    await writeFile(join(box.data, 'changed.jpg'), 'old cover');
    await box.setDue(dueRow());
    await box.run();
    const [first] = await box.folders();

    await writeFile(join(box.data, 'changed.jpg'), 'new cover, longer');
    const requestedAt = await secondAfter(String((await box.manifest(first)).createdAt));
    await box.setDue(dueRow({ requestedAt }));
    await box.run();
    const [, second] = await box.folders();

    const inode = async (folder: string, file: string) =>
      (await stat(join(box.backups, folder, 'media', file))).ino;
    expect(second).toBeDefined();
    expect(await inode(second, 'kept.mp3')).toBe(await inode(first, 'kept.mp3'));
    expect(await inode(second, 'changed.jpg')).not.toBe(await inode(first, 'changed.jpg'));
    expect(await readFile(join(box.backups, second, 'media', 'changed.jpg'), 'utf8')).toBe(
      'new cover, longer',
    );
  });

  it('records media as skipped on object storage, where there is no /data to snapshot', async () => {
    const box = await sidecar({ STORAGE_PROVIDER: 's3' });
    await writeFile(join(box.data, 'track.mp3'), 'audio');
    await box.setDue(dueRow());

    await box.run();

    const [folder] = await box.folders();
    expect(await readdir(join(box.backups, folder)).then((names) => names.sort())).toEqual([
      'db.sql.gz',
      'manifest.json',
    ]);
    expect(await box.manifest(folder)).toMatchObject({
      includesMedia: false,
      mediaSkipped: 'object-storage',
      mediaBytes: 0,
      mediaFiles: 0,
    });
  });

  it('refuses to run below the free-space floor', async () => {
    const box = await sidecar({ BACKUP_MIN_FREE_BYTES: '1000000000000000000' });
    await box.setDue(dueRow());

    await box.run();

    expect(await box.dumps()).toBe(0);
    expect(await box.folders()).toEqual([]);
    expect(await box.status()).toMatchObject({ lastAttempt: { ok: false, error: 'low-disk' } });
  });

  describe('the first media snapshot', () => {
    const MIB = 1024 * 1024;

    /** 1 MiB floor, 2 MiB free, and a 2 MiB library: enough to start, not to copy it all. */
    async function tightDisk(): Promise<Sidecar> {
      const box = await sidecar({ BACKUP_MIN_FREE_BYTES: String(MIB) });
      await writeFile(join(box.data, 'track.mp3'), Buffer.alloc(2 * MIB, 1));
      await box.setFreeBytes(2 * MIB);
      await box.setDue(dueRow());
      return box;
    }

    it('is refused when copying the whole library would cross the free-space floor', async () => {
      const box = await tightDisk();

      await box.run();

      expect(await box.dumps()).toBe(0);
      expect(await box.status()).toMatchObject({ lastAttempt: { ok: false, error: 'low-disk' } });
    });

    it('runs once a snapshot exists to hardlink unchanged files against', async () => {
      const box = await tightDisk();
      const seeded = await box.seedBackup('20000101T000000Z');
      await mkdir(join(box.backups, seeded, 'media'));

      await box.run();

      expect(await box.dumps()).toBe(1);
      expect(await box.status()).toMatchObject({ lastAttempt: { ok: true } });
    });
  });

  it('leaves the flat files of earlier versions alone', async () => {
    const box = await sidecar();
    const legacy = [
      'liedmotif-db-20250101T000000Z.sql.gz',
      'liedmotif-media-20250101T000000Z.tar.gz',
    ];
    for (const name of legacy) await writeFile(join(box.backups, name), 'legacy');
    await box.seedBackup('20000101T000000Z');
    await box.setDue(dueRow({ keep: 1 }));

    await box.run();

    const names = await readdir(box.backups);
    expect(names).toEqual(expect.arrayContaining(legacy));
    expect(await box.folders()).toHaveLength(1);
  });

  it('never writes the passphrase or the database password to status, manifest or log', async () => {
    const secrets = {
      BACKUP_ENCRYPTION_PASSPHRASE: 'sentinel-passphrase-7f3a',
      PGHOST: 'sentinel-host-91c2',
      PGUSER: 'sentinel-user-44d0',
      PGPASSWORD: 'sentinel-password-e81b',
      PGDATABASE: 'sentinel-database-0c57',
    };
    const box = await sidecar(secrets);
    await box.setDue(dueRow());
    const succeeded = await box.run();
    const [folder] = await box.folders();
    const dump = await readFile(join(box.backups, folder, 'db.sql.gz.enc'));

    await box.failDump();
    const requestedAt = await secondAfter(String((await box.manifest(folder)).createdAt));
    await box.setDue(dueRow({ requestedAt }));
    const failed = await box.run();
    await box.setDue(null);
    const unreachable = await box.run();

    expect(dump.subarray(0, 8).toString()).toBe('Salted__');
    expect(await box.manifest(folder)).toMatchObject({ encrypted: true });
    const written = [
      succeeded.output,
      failed.output,
      unreachable.output,
      JSON.stringify(await box.status()),
      JSON.stringify(await box.manifest(folder)),
    ].join('\n');
    expect(written).toContain('dump-failed');
    expect(written).not.toContain(secrets.BACKUP_ENCRYPTION_PASSPHRASE);
    expect(written).not.toContain(secrets.PGPASSWORD);
    // The web app shows status and manifests: they carry no part of the connection.
    const shown = JSON.stringify([await box.status(), await box.manifest(folder)]);
    for (const secret of Object.values(secrets)) expect(shown).not.toContain(secret);
  });

  it('logs the tool’s own error, so a failed dump says why', async () => {
    const box = await sidecar();
    await box.setDue(dueRow());
    await box.failDump();

    const { output } = await box.run();

    expect(output).toContain('pg_dump: error: connection to server');
    expect(await box.status()).toMatchObject({ lastAttempt: { ok: false, error: 'dump-failed' } });
  });

  it('reports the previous attempt, not a mix with the running one, while a backup runs', async () => {
    const box = await sidecar();
    await box.setDue(dueRow());
    await box.run();
    const previous = (await box.status()).lastAttempt;
    const requestedAt = await secondAfter(String((previous as { startedAt: string }).startedAt));
    await box.setDue(dueRow({ requestedAt }));

    await box.run();

    const during = await box.statusDuringDump();
    expect(during.lastAttempt).toEqual(previous);
    expect(during.running).toMatchObject({ trigger: 'manual' });
  });

  describe('after a failed run', () => {
    /** Seconds from the failed attempt's end to the retry the status announces. */
    async function retryDelaySeconds(box: Sidecar): Promise<number> {
      const status = await box.status();
      const { finishedAt } = status.lastAttempt as { finishedAt: string };
      return (Date.parse(String(status.retryAt)) - Date.parse(finishedAt)) / 1000;
    }

    it('retries after BACKUP_RETRY_SECONDS, doubling while it keeps failing', async () => {
      const box = await sidecar({ BACKUP_RETRY_SECONDS: '1' });
      await box.setDue(dueRow());
      await box.failDump();

      const delays: number[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        await box.run();
        delays.push(await retryDelaySeconds(box));
        await secondAfter(String((await box.status()).retryAt));
      }

      expect(delays).toEqual([1, 2, 4]);
      expect(await box.dumps()).toBe(3);
    }, 20_000);

    it('waits out the backoff instead of retrying on the next check', async () => {
      const box = await sidecar({ BACKUP_RETRY_SECONDS: '3600' });
      await box.setDue(dueRow());
      await box.failDump();

      await box.run();
      await box.run();

      expect(await box.dumps()).toBe(1);
      expect(await retryDelaySeconds(box)).toBe(3600);
    });

    it('never waits longer than a day', async () => {
      const box = await sidecar({ BACKUP_RETRY_SECONDS: '100000' });
      await box.setDue(dueRow());
      await box.failDump();

      await box.run();

      expect(await retryDelaySeconds(box)).toBe(86_400);
    });

    it('runs a Back up now request without waiting out the backoff', async () => {
      const box = await sidecar({ BACKUP_RETRY_SECONDS: '3600' });
      await box.setDue(dueRow());
      await box.failDump();
      await box.run();

      const { lastAttempt } = await box.status();
      const requestedAt = await secondAfter((lastAttempt as { startedAt: string }).startedAt);
      await box.setDue(dueRow({ requestedAt }));
      await box.run();

      expect(await box.dumps()).toBe(2);
    });
  });

  it('reports an unreachable database within one check when it has never backed up', async () => {
    const box = await sidecar();
    await box.setDue(null);

    await box.run();

    expect(await box.status()).toMatchObject({
      lastAttempt: { ok: false, error: 'database-unreachable' },
      lastSuccessAt: null,
    });
    expect(await box.dumps()).toBe(0);
  });

  describe('healthcheck', () => {
    it('is healthy once a backup has landed', async () => {
      const box = await sidecar();
      await box.setDue(dueRow());
      expect((await box.run('--healthcheck')).code).not.toBe(0);

      await box.run();

      expect((await box.run('--healthcheck')).code).toBe(0);
    });

    /** A weekly schedule whose last success was `ageMs` ago and whose retry keeps failing. */
    async function failingSince(ageMs: number): Promise<Sidecar> {
      const box = await sidecar({ BACKUP_RETRY_SECONDS: '3600' });
      await box.seedBackup(isoSeconds(Date.now() - ageMs).replace(/[-:]/g, ''));
      await box.setDue(dueRow());
      await box.failDump();
      await box.run();
      return box;
    }

    it('stays healthy while it retries one missed slot', async () => {
      const box = await failingSince(2 * DAY_MS);

      expect(await box.status()).toMatchObject({ overdue: true });
      expect((await box.run('--healthcheck')).code).toBe(0);
    });

    it('turns unhealthy once a second slot is missed', async () => {
      const box = await failingSince(9 * DAY_MS);

      expect((await box.run('--healthcheck')).code).not.toBe(0);
    });

    it('stays healthy with the schedule off', async () => {
      const box = await sidecar();
      await box.setDue(dueRow({ enabled: false }));

      await box.run();

      expect((await box.run('--healthcheck')).code).toBe(0);
    });
  });

  it('says where the retired interval, keep and media settings went', async () => {
    const box = await sidecar({ BACKUP_KEEP: '14', BACKUP_INTERVAL_SECONDS: '86400' });
    await box.setDue(dueRow({ enabled: false }));

    const { output } = await box.run();

    expect(output.match(/Settings → Backups/g)).toHaveLength(1);
  });
});

/** Runs `docker/backup.sh` with `args` under `env`, collecting stdout and stderr. */
function runScript(
  env: Record<string, string>,
  args: string[],
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [BACKUP_SCRIPT, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

interface Restorer {
  /** The media directory the restore replaces (`/data` in the container). */
  data: string;
  run: (...args: string[]) => Promise<{ code: number | null; output: string }>;
  /**
   * Every SQL session `psql` ran, in order, or null when nothing reached the
   * database. A `--single-transaction` session sits between `BEGIN;` and
   * `COMMIT;`, as psql runs it.
   */
  replayed: () => Promise<string | null>;
  /** The target database answers that its worker reported a moment ago. */
  workerRunning: () => Promise<void>;
}

/** `docker/backup.sh restore` against a stubbed `psql` and a temp media directory. */
async function restorer(env: Record<string, string> = {}): Promise<Restorer> {
  const root = await mkdtemp(join(tmpdir(), 'liedmotif-restore-'));
  const bin = join(root, 'bin');
  const data = join(root, 'data');
  await Promise.all([mkdir(bin), mkdir(data)]);

  const replayedFile = join(root, 'replayed.sql');
  const workerFile = join(root, 'worker-running');

  // `psql -c` answers a query: the only one a restore asks is whether the
  // worker's heartbeat is fresh. Without `-c`, psql replays SQL from stdin.
  await writeFile(
    join(bin, 'psql'),
    `#!/bin/sh
single=false
for arg in "$@"; do
  case "$arg" in
    -c)
      if [ -f '${workerFile}' ]; then echo t; else echo f; fi
      exit 0
      ;;
    -1 | --single-transaction) single=true ;;
  esac
done
{
  if [ "$single" = true ]; then echo 'BEGIN;'; fi
  cat
  if [ "$single" = true ]; then echo 'COMMIT;'; fi
} >>'${replayedFile}'
`,
    { mode: 0o755 },
  );

  const restoreEnv = {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    BACKUP_DIR: join(root, 'backups'),
    MEDIA_DIR: data,
    MEDIA_OWNER: `${process.getuid?.()}:${process.getgid?.()}`,
    BACKUP_ENCRYPTION_PASSPHRASE: '',
    ...env,
  };

  return {
    data,
    run: (...args) => runScript(restoreEnv, args),
    replayed: () => readFile(replayedFile, 'utf8').catch(() => null),
    workerRunning: () => writeFile(workerFile, ''),
  };
}

describe('restore', () => {
  /** A complete backup the sidecar wrote, holding `track.mp3` in its media. */
  async function backedUp(env: Record<string, string> = {}) {
    const box = await sidecar(env);
    await writeFile(join(box.data, 'track.mp3'), 'audio');
    await box.setDue(dueRow());
    await box.run();
    const [folder] = await box.folders();
    return { box, folder };
  }

  it('replays a backup folder into the database and mirrors its media into /data', async () => {
    const { box, folder } = await backedUp();
    const target = await restorer({ BACKUP_DIR: box.backups });
    await writeFile(join(target.data, 'newer-than-backup.mp3'), 'newer audio');

    const { code, output } = await target.run('restore', folder, '--yes');

    expect(code).toBe(0);
    expect(await target.replayed()).toContain('-- PostgreSQL database dump\n');
    expect(await readdir(target.data)).toEqual(['track.mp3']);
    expect(await readFile(join(target.data, 'track.mp3'), 'utf8')).toBe('audio');
    for (const secret of ['CREDENTIAL_ENCRYPTION_KEY', 'APP_SECRET', 'BETTER_AUTH_SECRET']) {
      expect(output).toContain(secret);
    }
  });

  it('replays into empty schemas, so tables from a newer migration cannot block it', async () => {
    const backups = await mkdtemp(join(tmpdir(), 'liedmotif-backups-'));
    const folder = 'liedmotif-backup-20261025T030000Z';
    await mkdir(join(backups, folder));
    // The shape of a real `pg_dump --clean --if-exists`: it creates every
    // schema but `public`, which it assumes exists.
    const dump = [
      '-- PostgreSQL database dump',
      'DROP SCHEMA IF EXISTS graphile_worker;',
      'DROP SCHEMA IF EXISTS drizzle;',
      'CREATE SCHEMA drizzle;',
      'CREATE SCHEMA graphile_worker;',
      'CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;',
      'CREATE TABLE public.tracks (id uuid);',
      '',
    ].join('\n');
    await writeFile(join(backups, folder, 'db.sql.gz'), gzipSync(dump));
    await writeFile(
      join(backups, folder, 'manifest.json'),
      JSON.stringify({ format: 1, includesMedia: false }),
    );
    const target = await restorer({ BACKUP_DIR: backups });

    const { code } = await target.run('restore', folder, '--yes');

    expect(code).toBe(0);
    expect(await target.replayed()).toBe(
      [
        'BEGIN;',
        'DROP SCHEMA IF EXISTS public CASCADE;',
        'DROP SCHEMA IF EXISTS drizzle CASCADE;',
        'DROP SCHEMA IF EXISTS graphile_worker CASCADE;',
        'CREATE SCHEMA public;',
        dump + 'COMMIT;',
        '',
      ].join('\n'),
    );
  });

  it('says what it would replace and changes nothing without --yes', async () => {
    const { box, folder } = await backedUp();
    const target = await restorer({
      BACKUP_DIR: box.backups,
      PGHOST: 'db.internal',
      PGDATABASE: 'liedmotif_prod',
    });
    await writeFile(join(target.data, 'newer-than-backup.mp3'), 'newer audio');

    const { code, output } = await target.run('restore', folder);

    expect(code).not.toBe(0);
    expect(output).toContain('liedmotif_prod');
    expect(output).toContain('db.internal');
    expect(output).toContain(target.data);
    expect(output).toContain('--yes');
    expect(await target.replayed()).toBeNull();
    expect(await readdir(target.data)).toEqual(['newer-than-backup.mp3']);
  });

  it('refuses a backup format it does not know', async () => {
    const { box, folder } = await backedUp();
    const manifestFile = join(box.backups, folder, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    await writeFile(manifestFile, JSON.stringify({ ...manifest, format: 2 }));
    const target = await restorer({ BACKUP_DIR: box.backups });
    await writeFile(join(target.data, 'newer-than-backup.mp3'), 'newer audio');

    const { code, output } = await target.run('restore', folder, '--yes');

    expect(code).not.toBe(0);
    expect(output).toContain('format 2');
    expect(await target.replayed()).toBeNull();
    expect(await readdir(target.data)).toEqual(['newer-than-backup.mp3']);
  });

  it('refuses while a worker is still running against the target database', async () => {
    const { box, folder } = await backedUp();
    const target = await restorer({ BACKUP_DIR: box.backups });
    await target.workerRunning();
    await writeFile(join(target.data, 'newer-than-backup.mp3'), 'newer audio');

    const { code, output } = await target.run('restore', folder, '--yes');

    expect(code).not.toBe(0);
    expect(output).toMatch(/worker/);
    expect(await target.replayed()).toBeNull();
    expect(await readdir(target.data)).toEqual(['newer-than-backup.mp3']);
  });

  it.skipIf(process.getuid?.() === 0)(
    'changes nothing when the media directory is read-only',
    async () => {
      const { box, folder } = await backedUp();
      const target = await restorer({ BACKUP_DIR: box.backups });
      await writeFile(join(target.data, 'newer-than-backup.mp3'), 'newer audio');
      await chmod(target.data, 0o555);

      const { code, output } = await target.run('restore', folder, '--yes');
      await chmod(target.data, 0o755);

      expect(code).not.toBe(0);
      expect(output).toContain('-e MEDIA_DIR=/restore/data');
      expect(await target.replayed()).toBeNull();
      expect(await readdir(target.data)).toEqual(['newer-than-backup.mp3']);
    },
  );

  it('leaves /data alone and warns when the backup holds no media', async () => {
    const box = await sidecar();
    await box.setDue(dueRow({ includeMedia: false }));
    await box.run();
    const [folder] = await box.folders();
    const target = await restorer({ BACKUP_DIR: box.backups });
    await writeFile(join(target.data, 'track.mp3'), 'audio');

    const { code, output } = await target.run('restore', folder, '--yes');

    expect(code).toBe(0);
    expect(await target.replayed()).toContain('-- PostgreSQL database dump\n');
    expect(await readdir(target.data)).toEqual(['track.mp3']);
    expect(output).toMatch(/Tracks may not play/);
  });

  it('refuses a backup whose manifest lists media it does not hold, changing nothing', async () => {
    const box = await sidecar();
    await box.setDue(dueRow());
    await box.run();
    const [folder] = await box.folders();
    await rm(join(box.backups, folder, 'media'), { recursive: true });
    const target = await restorer({ BACKUP_DIR: box.backups });
    await writeFile(join(target.data, 'track.mp3'), 'audio');

    const { code, output } = await target.run('restore', folder, '--yes');

    expect(code).not.toBe(0);
    expect(output).toMatch(/incomplete/);
    expect(await target.replayed()).toBeNull();
    expect(await readdir(target.data)).toEqual(['track.mp3']);
  });

  describe('from a download', () => {
    const passphrase = 'sentinel-passphrase-5b19';

    /** What Settings → Backups downloads for `folder`, saved as a file. */
    async function downloaded(backups: string, folder: string, key: string): Promise<string> {
      const file = join(await mkdtemp(join(tmpdir(), 'liedmotif-download-')), `${folder}.tar.enc`);
      const body = await new Response(encryptedBackupStream(backups, folder, key)).arrayBuffer();
      await writeFile(file, Buffer.from(body));
      return file;
    }

    it('opens the archive and the dump inside it with the passphrase', async () => {
      const { box, folder } = await backedUp({ BACKUP_ENCRYPTION_PASSPHRASE: passphrase });
      const archive = await downloaded(box.backups, folder, passphrase);
      const target = await restorer({
        BACKUP_ENCRYPTION_PASSPHRASE: passphrase,
        PGPASSWORD: 'sentinel-password-a3e7',
      });

      const { code, output } = await target.run('restore', archive, '--yes');

      expect(code).toBe(0);
      expect(await target.replayed()).toContain('-- PostgreSQL database dump\n');
      expect(await readFile(join(target.data, 'track.mp3'), 'utf8')).toBe('audio');
      expect(output).not.toContain(passphrase);
      expect(output).not.toContain('sentinel-password-a3e7');
    }, 20_000);

    it('changes nothing when the passphrase does not open it', async () => {
      const { box, folder } = await backedUp({ BACKUP_ENCRYPTION_PASSPHRASE: passphrase });
      const archive = await downloaded(box.backups, folder, passphrase);
      const target = await restorer({ BACKUP_ENCRYPTION_PASSPHRASE: 'some other passphrase' });
      await writeFile(join(target.data, 'newer-than-backup.mp3'), 'newer audio');

      const { code, output } = await target.run('restore', archive, '--yes');

      expect(code).not.toBe(0);
      expect(output).toMatch(/passphrase/i);
      expect(await target.replayed()).toBeNull();
      expect(await readdir(target.data)).toEqual(['newer-than-backup.mp3']);
    }, 20_000);
  });
});
