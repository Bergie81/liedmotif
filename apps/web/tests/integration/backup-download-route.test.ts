// Settings → Backups download: one complete backup folder as a tar, encrypted
// in the `openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -md sha256` format with
// the operator's `.env` passphrase. The fixtures are folders in the shape the
// backup sidecar writes; decryption here follows that openssl format with Node
// `crypto`, independently of the route's own code.

import { execFileSync } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const holder = vi.hoisted(() => ({ admin: true }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.admin ? { user: { id: 'admin-1' } } : null),
  getAppSession: async () => ({ user: { id: holder.admin ? 'admin-1' : 'member-1' } }),
}));

const download = await import('@/app/api/settings/backups/[id]/download/route');

const PASSPHRASE = 'correct horse battery staple';
const BACKUP_ID = 'liedmotif-backup-20261101T020003Z';
const MANIFEST = {
  format: 1,
  createdAt: '2026-11-01T02:01:00Z',
  trigger: 'manual',
  encrypted: true,
  includesMedia: true,
  dbBytes: 14,
  mediaBytes: 11,
  mediaFiles: 1,
};

let backupDir: string;
let scratchDir: string;

function get(id: string) {
  return download.GET(
    new Request(`http://localhost/api/settings/backups/${encodeURIComponent(id)}/download`),
    { params: Promise.resolve({ id }) },
  );
}

async function writeBackup(id: string) {
  await mkdir(join(backupDir, id, 'media', 'tracks'), { recursive: true });
  await writeFile(join(backupDir, id, 'manifest.json'), JSON.stringify(MANIFEST));
  await writeFile(join(backupDir, id, 'db.sql.gz.enc'), 'encrypted dump');
  await writeFile(join(backupDir, id, 'media', 'tracks', 'a.mp3'), 'audio bytes');
}

/** `openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256`, in Node. */
function opensslDecrypt(blob: Buffer, passphrase: string): Buffer {
  expect(blob.subarray(0, 8).toString('latin1')).toBe('Salted__');
  const salt = blob.subarray(8, 16);
  const keyAndIv = pbkdf2Sync(passphrase, salt, 600_000, 48, 'sha256');
  const decipher = createDecipheriv(
    'aes-256-cbc',
    keyAndIv.subarray(0, 32),
    keyAndIv.subarray(32, 48),
  );
  return Buffer.concat([decipher.update(blob.subarray(16)), decipher.final()]);
}

/** Extracts a tar into a fresh folder and returns that folder. */
async function extractTar(tar: Buffer): Promise<string> {
  const out = await mkdtemp(join(scratchDir, 'extract-'));
  const file = join(scratchDir, 'backup.tar');
  await writeFile(file, tar);
  execFileSync('tar', ['-xf', file, '-C', out]);
  return out;
}

beforeEach(async () => {
  holder.admin = true;
  backupDir = await mkdtemp(join(tmpdir(), 'liedmotif-backups-'));
  scratchDir = await mkdtemp(join(tmpdir(), 'liedmotif-backup-download-'));
  process.env.BACKUP_DIR = backupDir;
  process.env.BACKUP_ENCRYPTION_PASSPHRASE = PASSPHRASE;
});

afterEach(async () => {
  delete process.env.BACKUP_DIR;
  delete process.env.BACKUP_ENCRYPTION_PASSPHRASE;
  await rm(backupDir, { recursive: true, force: true });
  await rm(scratchDir, { recursive: true, force: true });
});

describe('GET /api/settings/backups/[id]/download', () => {
  it('streams the backup folder as a tar only the passphrase opens', async () => {
    await writeBackup(BACKUP_ID);

    const res = await get(BACKUP_ID);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="${BACKUP_ID}.tar.enc"`,
    );
    expect(res.headers.get('cache-control')).toBe('private, no-store');

    const blob = Buffer.from(await res.arrayBuffer());
    const out = await extractTar(opensslDecrypt(blob, PASSPHRASE));
    expect(JSON.parse(await readFile(join(out, BACKUP_ID, 'manifest.json'), 'utf8'))).toEqual(
      MANIFEST,
    );
    expect(await readFile(join(out, BACKUP_ID, 'db.sql.gz.enc'), 'utf8')).toBe('encrypted dump');
    expect(await readFile(join(out, BACKUP_ID, 'media', 'tracks', 'a.mp3'), 'utf8')).toBe(
      'audio bytes',
    );
    expect(blob.includes('audio bytes')).toBe(false);
    expect(blob.includes('manifest.json')).toBe(false);
  }, 30_000);

  it('answers 404 for anything but a complete backup folder name', async () => {
    await writeBackup(BACKUP_ID);
    // Each of these names an existing folder once joined to BACKUP_DIR.
    for (const id of [
      '..',
      '.',
      `${BACKUP_ID}/..`,
      `../${backupDir.split('/').pop()}/${BACKUP_ID}`,
      `${BACKUP_ID}/media`,
      ` ${BACKUP_ID}`,
      `${BACKUP_ID}\n`,
    ]) {
      expect((await get(id)).status, JSON.stringify(id)).toBe(404);
    }
    expect((await get('liedmotif-backup-20261108T020000Z')).status).toBe(404);
  });

  it('answers 404 for a backup still being written', async () => {
    await writeBackup('.partial-20261108T020000Z');
    expect((await get('.partial-20261108T020000Z')).status).toBe(404);
  });

  it('answers 404 when no backups volume is mounted', async () => {
    await writeBackup(BACKUP_ID);
    delete process.env.BACKUP_DIR;
    expect((await get(BACKUP_ID)).status).toBe(404);
  });

  it('answers 409 instead of an unencrypted archive when no passphrase is set', async () => {
    await writeBackup(BACKUP_ID);
    for (const passphrase of [undefined, '']) {
      if (passphrase === undefined) delete process.env.BACKUP_ENCRYPTION_PASSPHRASE;
      else process.env.BACKUP_ENCRYPTION_PASSPHRASE = passphrase;
      const res = await get(BACKUP_ID);
      expect(res.status).toBe(409);
      expect(await res.text()).toContain('BACKUP_ENCRYPTION_PASSPHRASE');
    }
  });

  // Root reads a mode-000 file anyway, so there tar cannot be made to fail.
  it.skipIf(process.getuid?.() === 0)(
    'breaks the download instead of finishing a file that is missing part of the backup',
    async () => {
      await writeBackup(BACKUP_ID);
      await chmod(join(backupDir, BACKUP_ID, 'media', 'tracks', 'a.mp3'), 0o000);
      const res = await get(BACKUP_ID);
      expect(res.status).toBe(200);
      await expect(res.arrayBuffer()).rejects.toThrow();
    },
    30_000,
  );

  // `requireAdminOwnerId` refuses a Member exactly like a signed-out caller
  // (401), so probing an admin route tells a Member nothing.
  it('refuses a Member', async () => {
    await writeBackup(BACKUP_ID);
    holder.admin = false;
    const res = await get(BACKUP_ID);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthorized');
  });
});
