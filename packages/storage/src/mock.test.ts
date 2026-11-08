import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockStorageProvider } from './mock';

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('createMockStorageProvider', () => {
  let cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.map((c) => c()));
    cleanups = [];
  });

  it('round-trips through a fresh temp directory and cleans up', async () => {
    const mock = createMockStorageProvider();
    cleanups.push(mock.cleanup);

    await mock.provider.write({ key: 'tracks/u/t/original.mp3', body: Buffer.from('audio') });
    const read = await collect(await mock.provider.readStream('tracks/u/t/original.mp3'));
    expect(read.toString()).toBe('audio');

    await mock.cleanup();
    cleanups = [];
    await expect(stat(mock.dataRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('isolates each mock instance in its own directory', () => {
    const a = createMockStorageProvider();
    const b = createMockStorageProvider();
    cleanups.push(a.cleanup, b.cleanup);
    expect(a.dataRoot).not.toBe(b.dataRoot);
  });
});
