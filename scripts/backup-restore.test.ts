import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { restoreRun } from './backup-restore.mjs';

/** `npm run backup:restore`: the `docker run` that restores a download into the local setup. */
describe('backup:restore', () => {
  const password = 'sentinel-password-2c8f';
  const passphrase = 'sentinel-passphrase-9d41';

  function run(databaseUrl: string, env: Record<string, string> = {}) {
    return restoreRun({
      archive: '/home/me/Downloads/liedmotif-backup-20261025T030000Z.tar.enc',
      yes: true,
      owner: '501:20',
      env: {
        DATABASE_URL: databaseUrl,
        DATA_DIR: '/home/me/liedmotif/data',
        BACKUP_ENCRYPTION_PASSPHRASE: passphrase,
        ...env,
      },
    });
  }

  it('runs the image docker-compose.yml names for the backup service', () => {
    const url = `postgres://liedmotif:${password}@localhost:5433/liedmotif_dev`;
    const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
    const template = compose.match(/^ {2}backup:\n {4}image: (\S+)$/m)?.[1] ?? '';
    const tag = '${LIEDMOTIF_VERSION:-local}';
    expect(template).toContain(tag);
    const image = (version: string) => template.replace(tag, version);

    expect(run(url).args).toContain(image('local'));
    expect(run(url, { LIEDMOTIF_VERSION: '' }).args).toContain(image('local'));
    expect(run(url, { LIEDMOTIF_VERSION: '1.2.0' }).args).toContain(image('1.2.0'));
  });

  it.each(['localhost', '127.0.0.1'])(
    'reaches a database on %s through the Docker host',
    (host) => {
      const { env } = run(`postgres://liedmotif:${password}@${host}:5433/liedmotif_dev`);

      expect(env).toMatchObject({
        PGHOST: 'host.docker.internal',
        PGPORT: '5433',
        PGUSER: 'liedmotif',
        PGPASSWORD: password,
        PGDATABASE: 'liedmotif_dev',
      });
    },
  );

  it('keeps any other database host as it is', () => {
    const { env } = run('postgres://liedmotif:p%40ss@db.example.net/liedmotif');

    expect(env).toMatchObject({
      PGHOST: 'db.example.net',
      PGPORT: '5432',
      PGPASSWORD: 'p@ss',
      PGDATABASE: 'liedmotif',
    });
  });

  it('keeps the database URL’s TLS policy', () => {
    const { args, env } = run(
      'postgres://liedmotif:p@db.example.net/liedmotif?sslmode=verify-full',
    );

    expect(env.PGSSLMODE).toBe('verify-full');
    expect(args).toEqual(expect.arrayContaining(['-e', 'PGSSLMODE']));
  });

  it('hands the password and the passphrase over by name, never on the command line', () => {
    const { args, env } = run(`postgres://liedmotif:${password}@localhost:5433/liedmotif_dev`);

    expect(args.join(' ')).not.toContain(password);
    expect(args.join(' ')).not.toContain(passphrase);
    expect(env).toMatchObject({ PGPASSWORD: password, BACKUP_ENCRYPTION_PASSPHRASE: passphrase });
    expect(args).toEqual(
      expect.arrayContaining(['-e', 'PGPASSWORD', '-e', 'BACKUP_ENCRYPTION_PASSPHRASE']),
    );
  });
});
