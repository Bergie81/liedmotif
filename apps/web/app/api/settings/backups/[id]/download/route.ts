// Admin-only: download one backup as an encrypted tar (`lib/admin/backup-download.ts`).
// Only a complete folder on the backups volume is served: the id must be a
// backup folder name, which also rules out traversal and in-progress
// `.partial-*` runs.

import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { createLogger } from '@liedmotif/shared';
import { requireAdminOwnerId } from '@/lib/http/api-response';
import { BACKUP_ID_PATTERN, getBackupDir } from '@/lib/admin/backups';
import { encryptedBackupStream, getBackupPassphrase } from '@/lib/admin/backup-download';

export const dynamic = 'force-dynamic';

const logger = createLogger({ name: 'backup-download' });

const notFound = () => new NextResponse('Not found', { status: 404 });

async function isFolder(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const admin = await requireAdminOwnerId(request);
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;
  const dir = getBackupDir();
  if (!dir || !BACKUP_ID_PATTERN.test(id) || !(await isFolder(join(dir, id)))) return notFound();

  const passphrase = getBackupPassphrase();
  if (!passphrase) {
    return new NextResponse('Set BACKUP_ENCRYPTION_PASSPHRASE in .env to download backups.', {
      status: 409,
    });
  }

  logger.info('backup download started', { backup: id });
  return new Response(encryptedBackupStream(dir, id, passphrase), {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${id}.tar.enc"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
