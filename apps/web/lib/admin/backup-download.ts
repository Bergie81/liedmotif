// The Settings → Backups download (server-only): one complete backup folder as
// a tar, encrypted with the operator's `BACKUP_ENCRYPTION_PASSPHRASE` in the
// format `openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -md sha256` writes —
// the same format and parameters the backup sidecar uses for its dumps, so the
// restore path opens both with one openssl. A whole-instance archive holds
// every account's content, and the passphrase is what keeps a stolen Admin
// session from reading it.

import { spawn, type ChildProcess } from 'node:child_process';
import { createCipheriv, pbkdf2, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { createLogger } from '@liedmotif/shared';
import { webStreamFromReadable } from '../http/web-stream';

const logger = createLogger({ name: 'backup-download' });

const pbkdf2Async = promisify(pbkdf2);

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 8;
const KEY_BYTES = 32;
const IV_BYTES = 16;
const OPENSSL_MAGIC = Buffer.from('Salted__', 'latin1');

/** The passphrase downloads are encrypted with, or null when none is set. */
export function getBackupPassphrase(): string | null {
  return process.env.BACKUP_ENCRYPTION_PASSPHRASE || null;
}

/**
 * `tar -cf - -C <dir> <id>` piped through the openssl-compatible encryption:
 * `Salted__`, the 8-byte salt, then AES-256-CBC with key and IV both derived by
 * PBKDF2-SHA256 from the passphrase and salt. The final cipher block is written
 * only after tar exits cleanly, so a tar that fails part-way errors the stream
 * instead of ending in a file that decrypts as if it were complete. Cancelling
 * the stream kills tar.
 */
export function encryptedBackupStream(
  dir: string,
  id: string,
  passphrase: string,
): ReadableStream<Uint8Array> {
  let tar: ChildProcess | null = null;
  let cancelled = false;

  async function* encrypt(): AsyncGenerator<Buffer> {
    const salt = randomBytes(SALT_BYTES);
    const keyAndIv = await pbkdf2Async(
      passphrase,
      salt,
      PBKDF2_ITERATIONS,
      KEY_BYTES + IV_BYTES,
      'sha256',
    );
    if (cancelled) return;
    const cipher = createCipheriv(
      'aes-256-cbc',
      keyAndIv.subarray(0, KEY_BYTES),
      keyAndIv.subarray(KEY_BYTES),
    );

    // stderr is dropped: tar's messages name paths inside the backup, and only
    // the backup id is logged.
    const child = spawn('tar', ['-cf', '-', '-C', dir, id], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    tar = child;
    const exited = new Promise<number | null>((resolve) => {
      child.on('error', () => resolve(null));
      child.once('close', (code) => resolve(code));
    });

    try {
      yield Buffer.concat([OPENSSL_MAGIC, salt]);
      for await (const chunk of child.stdout) {
        const encrypted = cipher.update(chunk as Buffer);
        if (encrypted.length > 0) yield encrypted;
      }
      const exitCode = await exited;
      if (cancelled) return;
      if (exitCode !== 0) {
        logger.warn('backup download failed: tar did not finish', { backup: id, exitCode });
        throw new Error('The backup could not be read in full.');
      }
      yield cipher.final();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }

  return webStreamFromReadable(Readable.from(encrypt()), () => {
    cancelled = true;
    tar?.kill();
  });
}
