import { describe, expect, it } from 'vitest';
import {
  ProviderResponseTooLargeError,
  boundedResponseStream,
  readBoundedResponseBytes,
  readBoundedResponseJson,
} from './response-limit';

// The ceiling on a provider response has to hold BEFORE the bytes are in heap
// or through the disk reserve: a size checked after the body was read is not a
// bound, it is a report.

/** A body that yields `chunkCount` chunks, recording how many were asked for. */
function chunkedResponse(
  chunkCount: number,
  chunkSize: number,
  headers: Record<string, string> = {},
): { response: Response; pulls: () => number } {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunkCount) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(new Uint8Array(chunkSize).fill(7));
    },
  });
  return { response: new Response(body, { headers }), pulls: () => pulled };
}

describe('boundedResponseStream', () => {
  it('refuses a declared oversize body without reading it', () => {
    const { response, pulls } = chunkedResponse(4, 10, { 'content-length': '1000' });
    expect(() => boundedResponseStream(response, 100)).toThrow(ProviderResponseTooLargeError);
    expect(pulls()).toBe(0);
  });

  it('aborts mid-stream on the chunk that crosses the ceiling', async () => {
    // No declared length — an undeclared or lying body is exactly the case the
    // counting stream exists for, and it must stop pulling the rest.
    const { response, pulls } = chunkedResponse(100, 10);
    await expect(readBoundedResponseBytes(response, 25)).rejects.toThrow(
      ProviderResponseTooLargeError,
    );
    expect(pulls()).toBeLessThan(10);
  });

  it('passes a body at the ceiling through unchanged', async () => {
    const { response } = chunkedResponse(4, 10, { 'content-length': '40' });
    expect((await readBoundedResponseBytes(response, 40)).byteLength).toBe(40);
  });
});

describe('readBoundedResponseJson', () => {
  it('refuses an oversized payload instead of parsing it', async () => {
    const payload = JSON.stringify({ image: 'x'.repeat(500) });
    await expect(readBoundedResponseJson(new Response(payload), 100)).rejects.toThrow(
      ProviderResponseTooLargeError,
    );
    expect(await readBoundedResponseJson(new Response(payload), 10_000)).toEqual({
      image: 'x'.repeat(500),
    });
  });
});
