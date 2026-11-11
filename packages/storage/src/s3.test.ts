import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeStorageAdapterContract } from './adapter-contract';
import { readAllBytes } from './index';
import { s3StorageProvider, type S3StorageOptions } from './s3';

// The S3 contract leg runs against a REAL S3 server (`npm run s3:test:up`),
// gated as a whole on `TEST_S3_ENDPOINT` — an absent server is a visible skip,
// never a silently swapped path. Credentials/bucket default to the compose
// `s3-test` service's defaults so `.env` only needs the endpoint.

const TEST_S3_ENDPOINT = process.env.TEST_S3_ENDPOINT?.trim() || undefined;

// `endpoint` may be undefined here; every use sits inside the block gated on
// `TEST_S3_ENDPOINT`, so no request is ever built without it.
const options: Omit<S3StorageOptions, 'keyPrefix'> = {
  ...(TEST_S3_ENDPOINT ? { endpoint: TEST_S3_ENDPOINT } : {}),
  region: process.env.TEST_S3_REGION?.trim() || 'us-east-1',
  bucket: process.env.TEST_S3_BUCKET?.trim() || 'liedmotif-test',
  accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID?.trim() || 'liedmotif-test',
  secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY?.trim() || 'liedmotif-test-secret',
  forcePathStyle: true,
};

/** A fresh key prefix per harness keeps every test isolated in the shared bucket. */
function isolated(): S3StorageOptions {
  return { ...options, keyPrefix: `contract/${randomUUID()}` };
}

(TEST_S3_ENDPOINT ? describe : describe.skip)('s3StorageProvider (S3 server)', () => {
  beforeAll(async () => {
    const client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      forcePathStyle: true,
    });
    try {
      await client.send(new CreateBucketCommand({ Bucket: options.bucket }));
    } catch (err) {
      const name = (err as Error).name;
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err;
    } finally {
      client.destroy();
    }
  });

  describeStorageAdapterContract('s3', () => ({ storage: s3StorageProvider(isolated()) }));

  it('identifies itself as the s3 adapter', () => {
    expect(s3StorageProvider(isolated()).providerKey).toBe('s3');
  });

  it('stores objects under the configured key prefix while keys stay unprefixed', async () => {
    const prefix = `contract/${randomUUID()}`;
    const prefixed = s3StorageProvider({ ...options, keyPrefix: prefix });
    const bare = s3StorageProvider({ ...options });
    const key = 'tracks/u/t/original.mp3';

    const stat = await prefixed.write({ key, body: Buffer.from('prefixed bytes') });
    expect(stat.key).toBe(key);

    // The bare adapter sees the object only at the prefixed bucket key.
    expect(await bare.stat(key)).toBeNull();
    const viaBucketKey = await readAllBytes(await bare.readStream(`${prefix}/${key}`));
    expect(Buffer.from(viaBucketKey).toString()).toBe('prefixed bytes');

    // The read URL carries the storage key, not the bucket layout.
    expect(await prefixed.createReadUrl(key)).toBe(`/api/files/${key}`);
  });

  it('persists the content type on the object and reads it back from metadata', async () => {
    const storage = s3StorageProvider(isolated());
    const key = 'covers/uploaded/u/cover.bin';
    await storage.write({ key, body: Buffer.from('img'), mimeType: 'image/webp' });
    expect((await storage.stat(key))?.mimeType).toBe('image/webp');
  });

  it('upgrades a large streamed body to a multipart upload and round-trips it', async () => {
    // 6 MiB crosses the SDK's 5 MiB part size, so this exercises the real
    // multipart path (create/upload-part/complete), not a single PUT.
    const storage = s3StorageProvider(isolated());
    const key = 'tracks/u/t/original.mp3';
    const chunk = Buffer.alloc(1024 * 1024, 7);
    const body = Readable.from(
      (async function* () {
        for (let i = 0; i < 6; i += 1) yield chunk;
      })(),
    );
    const stat = await storage.write({ key, body, mimeType: 'audio/mpeg' });
    expect(stat.byteSize).toBe(6 * 1024 * 1024);

    const tail = await readAllBytes(await storage.readStream(key, { start: 6 * 1024 * 1024 - 4 }));
    expect(Buffer.from(tail).equals(Buffer.alloc(4, 7))).toBe(true);
  });
});

describe('s3StorageProvider error hygiene', () => {
  // No S3 server involved: an unreachable endpoint must surface a sanitized error.
  it('never leaks the endpoint, bucket, or credentials in a surfaced error', async () => {
    const storage = s3StorageProvider({
      endpoint: 'http://127.0.0.1:9',
      region: 'us-east-1',
      bucket: 'secret-bucket-name',
      accessKeyId: 'AKIA-test-access',
      secretAccessKey: 'super-secret-value',
      forcePathStyle: true,
    });
    let thrown: Error | undefined;
    try {
      await storage.write({ key: 'tracks/u/t/original.mp3', body: Buffer.from('x') });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.message).toContain('tracks/u/t/original.mp3');
    for (const secret of [
      '127.0.0.1:9',
      'secret-bucket-name',
      'AKIA-test-access',
      'super-secret-value',
    ]) {
      expect(thrown?.message).not.toContain(secret);
    }
  });
});

describe('s3StorageProvider upload timeouts', () => {
  const TIMEOUTS = { connectionMs: 1_000, requestMs: 300, uploadRequestMs: 1_500 };
  const BODY = Buffer.alloc(1024 * 1024, 1);
  let server: Server;
  let endpoint: string;
  let puts = 0;
  /** How the fake S3 endpoint treats a PUT body: read it slowly, or never. */
  let mode: 'slow' | 'stalled' = 'slow';

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method !== 'PUT') {
        res.writeHead(404).end();
        return;
      }
      puts += 1;
      if (mode === 'stalled') return;
      // ~0.7 s to read the whole body: past the read timeout, inside the
      // upload one.
      req.on('data', () => {
        req.pause();
        setTimeout(() => req.resume(), 40);
      });
      req.on('end', () => res.writeHead(200, { ETag: '"etag"' }).end());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  function storage() {
    return s3StorageProvider(
      {
        region: 'us-east-1',
        bucket: 'b',
        accessKeyId: 'k',
        secretAccessKey: 's',
        endpoint,
        forcePathStyle: true,
      },
      TIMEOUTS,
    );
  }

  it('stores an upload whose body takes longer to send than the request timeout', async () => {
    mode = 'slow';
    puts = 0;
    const started = Date.now();
    const stat = await storage().write({ key: 'tracks/u/s/t.mp3', body: BODY });
    expect(Date.now() - started).toBeGreaterThan(TIMEOUTS.requestMs);
    expect(stat.byteSize).toBe(BODY.byteLength);
    expect(puts).toBe(1);
  }, 15_000);

  it('still fails an upload the endpoint never answers', async () => {
    mode = 'stalled';
    await expect(storage().write({ key: 'tracks/u/s/t.mp3', body: BODY })).rejects.toThrow(
      /S3 write failed for key "tracks\/u\/s\/t\.mp3" \(TimeoutError\)/,
    );
  }, 15_000);
});
