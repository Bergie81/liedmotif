// `npm run backup:restore -- <file> [--yes]`: restores a backup downloaded from
// Settings → Backups into the local `npm run dev` setup, replacing the database
// in DATABASE_URL and the files in DATA_DIR. It runs the backup image's restore
// mode (docker/backup.sh), so psql, openssl and rsync come from the image and
// match the server; the host needs nothing but Docker.
//
// Secrets reach the container as environment variables passed by name
// (`-e NAME`), never as values on a command line any process on the host can
// read.

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

// Inside the container these name the container itself; Docker Desktop's name
// for the host is what reaches a database published on the host's loopback.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * The `docker run` arguments, and the environment to run them with, that
 * restore `archive` into the database in `env.DATABASE_URL` and the media
 * directory `env.DATA_DIR`. `owner` (`uid:gid`) is who the restored media
 * files belong to: the user `npm run dev` runs as.
 *
 * @param {{ archive: string, yes: boolean, owner: string, env: Record<string, string | undefined> }} options
 * @returns {{ args: string[], env: Record<string, string> }}
 */
export function restoreRun({ archive, yes, owner, env }) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  if (!env.DATA_DIR) throw new Error('DATA_DIR is not set');
  const url = new URL(env.DATABASE_URL);
  // What `docker compose build backup` tags: docker-compose.yml's `backup`
  // image, whose `${LIEDMOTIF_VERSION:-local}` also treats an empty value as unset.
  const image = `ghcr.io/bergie81/liedmotif-backup:${env.LIEDMOTIF_VERSION || 'local'}`;

  const containerEnv = {
    PGHOST: LOOPBACK_HOSTS.has(url.hostname) ? 'host.docker.internal' : url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    BACKUP_ENCRYPTION_PASSPHRASE: env.BACKUP_ENCRYPTION_PASSPHRASE ?? '',
    MEDIA_OWNER: owner,
    // The URL's TLS policy, so a remote database is not reached with less.
    ...(url.searchParams.get('sslmode') ? { PGSSLMODE: url.searchParams.get('sslmode') } : {}),
  };

  const args = [
    'run',
    '--rm',
    ...Object.keys(containerEnv).flatMap((name) => ['-e', name]),
    '-v',
    `${archive}:/restore/archive:ro`,
    '-v',
    `${env.DATA_DIR}:/data`,
    image,
    'restore',
    '/restore/archive',
    ...(yes ? ['--yes'] : []),
  ];
  return { args, env: containerEnv };
}

function fail(message) {
  console.error(`backup:restore: ${message}`);
  process.exit(1);
}

function main(argv) {
  const yes = argv.includes('--yes');
  const [file] = argv.filter((arg) => arg !== '--yes');
  if (!file) fail('usage: npm run backup:restore -- <liedmotif-backup-….tar.enc> [--yes]');

  // npm runs scripts from the repo root; INIT_CWD is where the command was typed.
  const archive = resolve(process.env.INIT_CWD ?? process.cwd(), file);
  if (!statSync(archive, { throwIfNoEntry: false })?.isFile()) fail(`no file at ${archive}`);
  const dataDir = process.env.DATA_DIR;
  if (dataDir && !statSync(dataDir, { throwIfNoEntry: false })?.isDirectory()) {
    fail('DATA_DIR is not a directory');
  }

  let run;
  try {
    run = restoreRun({
      archive,
      yes,
      owner: `${process.getuid()}:${process.getgid()}`,
      env: process.env,
    });
  } catch (error) {
    fail(error.message);
  }

  const build = spawnSync('docker', ['compose', 'build', 'backup'], { stdio: 'inherit' });
  if (build.status !== 0) fail('building the backup image failed');

  console.log(`DATA_DIR (${dataDir}) is /data in the restore container.`);
  const restore = spawnSync('docker', run.args, {
    stdio: 'inherit',
    env: { ...process.env, ...run.env },
  });
  process.exit(restore.status ?? 1);
}

if (import.meta.main) main(process.argv.slice(2));
