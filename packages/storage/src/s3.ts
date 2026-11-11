// S3-compatible object-storage adapter. Speaks the S3 *API* via the AWS SDK v3
// client, so any compatible service works (AWS, Cloudflare R2, Backblaze B2,
// Hetzner Object Storage, self-hosted MinIO) — a custom endpoint plus optional
// path-style addressing is all that differs per provider.
//
// Contract parity with `local-fs` is the point: the same lexical safe-key
// validation guards every operation, the persisted key layout is byte-for-byte
// identical (which makes a manual `/data` → bucket sync a valid migration), and
// `createReadUrl` returns the same app-routed shape — no presigned or public
// bucket URL ever reaches the browser.
//
// Write integrity: every body goes through the SDK's managed upload (a single
// PUT below the part size, multipart above it), and a failed upload is
// explicitly aborted so a partial object never becomes readable at the
// destination key — the S3-API equivalent of local-fs's temp-file-plus-rename.
// A completed upload is durable by service contract, so no fsync analog exists.
//
// Error hygiene: errors surfaced out of this adapter never carry the endpoint,
// bucket name, or credentials — only the operation, the storage key, and the
// service's error name (connection errors would otherwise embed the endpoint
// address in their message).

import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { Readable, Transform } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { contentTypeForKey } from './content-type';
import { appRoutedReadUrl, resolveReadUrlBase } from './read-url';
import { assertSafeKey } from './safe-key';
import type {
  ReadStreamOptions,
  StorageObjectStat,
  StorageObjectWithStream,
  StorageProvider,
  WriteObjectInput,
} from './index';

export interface S3StorageOptions {
  /** Bucket region (S3-compatible services accept any value, e.g. `us-east-1`). */
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Service endpoint URL. Omit for AWS itself. */
  endpoint?: string;
  /** Path-style addressing (`endpoint/bucket/key`); MinIO and some providers need it. */
  forcePathStyle?: boolean;
  /** Optional key prefix for sharing a bucket; storage keys stay unprefixed. */
  keyPrefix?: string;
  /** Base path for app-routed read URLs. Defaults to `/api/files`. */
  readUrlBase?: string;
}

/** The service-error fields the adapter dispatches on, probed from an unknown. */
function serviceErrorInfo(err: unknown): { name?: string; status?: number } {
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const status = e?.$metadata?.httpStatusCode;
  return {
    name: typeof e?.name === 'string' ? e.name : undefined,
    status: typeof status === 'number' ? status : undefined,
  };
}

/** True when the service reports the object (or bucket key) as absent. */
function isMissingObjectError(err: unknown): boolean {
  const { name, status } = serviceErrorInfo(err);
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}

/**
 * Wrap a service/network error without its original message: connection errors
 * embed the endpoint address, and service errors may echo the bucket. The error
 * name (`NoSuchKey`, `AccessDenied`, `ECONNREFUSED`, …) is kept for diagnosis.
 */
function storageError(operation: string, key: string, err: unknown): Error {
  const e = err as { name?: unknown; code?: unknown };
  const candidates = [e?.name, e?.code].filter((v): v is string => typeof v === 'string');
  const token = candidates.find((v) => v !== 'Error') ?? candidates[0] ?? 'unknown';
  return new Error(`S3 ${operation} failed for key "${key}" (${token})`);
}

/** Inclusive HTTP Range header for the S3 ranged GET, matching local-fs semantics. */
function rangeHeader(range?: ReadStreamOptions): string | undefined {
  const { start, end } = range ?? {};
  if (start === undefined && end === undefined) return undefined;
  const from = start ?? 0;
  return end === undefined ? `bytes=${from}-` : `bytes=${from}-${end}`;
}

/** The SDK types the body loosely; under the Node HTTP handler it is a `Readable`. */
function toNodeReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  throw new Error('S3 response body is not a Node readable stream');
}

/** True for the 416 the service returns when a range starts at/past the object size. */
function isUnsatisfiableRangeError(err: unknown): boolean {
  const { name, status } = serviceErrorInfo(err);
  return name === 'InvalidRange' || status === 416;
}

/** Total object size from a 206's `Content-Range: bytes X-Y/total`. */
function totalFromContentRange(contentRange: string | undefined): number | undefined {
  const total = /\/(\d+)$/.exec(contentRange ?? '')?.[1];
  return total === undefined ? undefined : Number(total);
}

/**
 * A wedged endpoint must fail fast, not pin a request slot indefinitely: the
 * SDK's defaults leave connection and response timeouts unset. The keep-alive
 * agents are sized well above the app's bounded fan-outs (~8 concurrent) so the
 * cap is a backstop, not a throttle.
 *
 * `requestTimeout` is a wall clock from request start to response headers. For
 * a GET that is time-to-first-byte, so a long audio stream is unaffected once
 * bytes flow. A PUT's headers only arrive after its whole body is sent, so
 * uploads run on their own client with a clock sized for sending one request
 * body (a single PUT or one part, ≤ 8 MB) over a slow uplink: 2 min still fits
 * 8 MB at about 0.6 Mbit/s.
 */
export interface S3Timeouts {
  connectionMs: number;
  /** Reads, stats and deletes: request start to response headers. */
  requestMs: number;
  /** Each upload request (a single PUT or one part), body included. */
  uploadRequestMs: number;
}
const S3_TIMEOUTS: S3Timeouts = {
  connectionMs: 3_000,
  requestMs: 30_000,
  uploadRequestMs: 120_000,
};
const S3_MAX_SOCKETS = 128;

/**
 * Managed-upload buffering bounds: the SDK defaults (5 MB parts × 4 queued)
 * hold up to 20 MB per in-flight streamed write; 8 MB × 2 keeps buffering
 * predictable while single-PUT-ing anything under 8 MB.
 */
const UPLOAD_PART_SIZE_BYTES = 8 * 1024 * 1024;
const UPLOAD_QUEUE_SIZE = 2;

/** `timeouts` is overridable only so tests can scale the bounds down. */
export function s3StorageProvider(
  options: S3StorageOptions,
  timeouts: S3Timeouts = S3_TIMEOUTS,
): StorageProvider {
  const bucket = options.bucket;
  const keyPrefix = options.keyPrefix ? assertSafeKey(options.keyPrefix) : undefined;
  const readUrlBase = resolveReadUrlBase(options.readUrlBase);
  const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: S3_MAX_SOCKETS });
  const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: S3_MAX_SOCKETS });
  const clientConfig = {
    region: options.region,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    forcePathStyle: options.forcePathStyle ?? false,
  };
  const client = new S3Client({
    ...clientConfig,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: timeouts.connectionMs,
      requestTimeout: timeouts.requestMs,
      // Without it the handler only logs a warning when the timeout passes and
      // the call never settles.
      throwOnRequestTimeout: true,
      httpAgent,
      httpsAgent,
    }),
  });
  const uploadClient = new S3Client({
    ...clientConfig,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: timeouts.connectionMs,
      requestTimeout: timeouts.uploadRequestMs,
      throwOnRequestTimeout: true,
      httpAgent,
      httpsAgent,
    }),
  });

  /** Validate a storage key (identically to local-fs) and map it to its bucket key. */
  function objectKey(key: string): string {
    assertSafeKey(key);
    return keyPrefix ? `${keyPrefix}/${key}` : key;
  }

  /** One GET for both read paths: whole object, or the inclusive range. */
  function getObject(target: string, header: string | undefined): Promise<GetObjectCommandOutput> {
    return client.send(
      new GetObjectCommand({ Bucket: bucket, Key: target, ...(header ? { Range: header } : {}) }),
    );
  }

  async function statObject(key: string): Promise<StorageObjectStat | null> {
    const target = objectKey(key);
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: target }));
      return {
        key,
        byteSize: head.ContentLength ?? 0,
        mimeType: head.ContentType ?? contentTypeForKey(key),
        updatedAt: head.LastModified ?? new Date(),
      };
    } catch (err) {
      if (isMissingObjectError(err)) return null;
      throw storageError('stat', key, err);
    }
  }

  return {
    providerKey: 's3',

    async write(input: WriteObjectInput): Promise<StorageObjectStat> {
      const target = objectKey(input.key);
      const contentType = input.mimeType ?? contentTypeForKey(input.key);
      // Count bytes in-band so the returned stat needs no follow-up HEAD — a
      // write that succeeded must never surface as failed because a later
      // metadata read hiccuped.
      let byteSize = 0;
      let body: Uint8Array | Transform;
      if (input.body instanceof Uint8Array) {
        byteSize = input.body.byteLength;
        body = input.body;
      } else {
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            byteSize += chunk.length;
            callback(null, chunk);
          },
        });
        // `.pipe()` does not forward source errors; without this a failing
        // body would stall the upload instead of rejecting it.
        input.body.on('error', (err) => counter.destroy(err));
        body = input.body.pipe(counter);
      }
      // One managed upload for every body: a single PUT below the part size,
      // multipart above it — either way the object only becomes readable on
      // completion.
      const upload = new Upload({
        client: uploadClient,
        params: { Bucket: bucket, Key: target, Body: body, ContentType: contentType },
        partSize: UPLOAD_PART_SIZE_BYTES,
        queueSize: UPLOAD_QUEUE_SIZE,
      });
      try {
        await upload.done();
      } catch (err) {
        // Abort the multipart upload so no partial object ever becomes
        // readable at the key (small bodies never started one; abort no-ops).
        await upload.abort().catch(() => {});
        // A failed upload stops reading mid-body; the source (a provider
        // download, a ranged read of another object) would otherwise stay open
        // with its connection held. local-fs's pipeline() does the same.
        if (!(input.body instanceof Uint8Array)) input.body.destroy();
        throw storageError('write', input.key, err);
      }
      return { key: input.key, byteSize, mimeType: contentType, updatedAt: new Date() };
    },

    async readStream(key: string, range?: ReadStreamOptions): Promise<Readable> {
      const target = objectKey(key);
      const header = rangeHeader(range);
      try {
        const response = await getObject(target, header);
        // The send() above has already failed for a missing key, so the caller
        // never receives a stream that errors later for absence.
        return toNodeReadable(response.Body);
      } catch (err) {
        // Range parity with local-fs: a start at/past the object size yields an
        // empty stream there, while S3 answers 416. A missing key is a 404, not
        // a 416, so it still rejects here before any stream is returned.
        if (header && isUnsatisfiableRangeError(err)) return Readable.from([]);
        throw storageError('read', key, err);
      }
    },

    async readStreamWithStat(
      key: string,
      range?: ReadStreamOptions,
    ): Promise<StorageObjectWithStream | null> {
      const target = objectKey(key);
      const header = rangeHeader(range);
      try {
        const response = await getObject(target, header);
        // A 206 reports the range length in ContentLength; the object's total
        // rides the Content-Range trailer.
        const total = header ? totalFromContentRange(response.ContentRange) : undefined;
        return {
          stream: toNodeReadable(response.Body),
          stat: {
            key,
            byteSize: total ?? response.ContentLength ?? 0,
            mimeType: response.ContentType ?? contentTypeForKey(key),
            updatedAt: response.LastModified ?? new Date(),
          },
        };
      } catch (err) {
        if (isMissingObjectError(err)) return null;
        // Range parity with readStream: a start at/past the object size yields
        // an empty stream — the extra HEAD for the stat only happens on this
        // rare out-of-range path.
        if (header && isUnsatisfiableRangeError(err)) {
          const stat = await statObject(key);
          return stat ? { stream: Readable.from([]), stat } : null;
        }
        throw storageError('read', key, err);
      }
    },

    async delete(key: string): Promise<void> {
      const target = objectKey(key);
      // S3 DeleteObject succeeds for a missing key, so idempotence is native.
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: target }));
      } catch (err) {
        throw storageError('delete', key, err);
      }
    },

    stat: statObject,

    async createReadUrl(key: string): Promise<string> {
      return appRoutedReadUrl(readUrlBase, key);
    },
  };
}
