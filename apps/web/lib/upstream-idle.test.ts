import { describe, expect, it, vi } from 'vitest';
import { withIdleTimeout } from './upstream-idle';

// The proxied-body idle watchdog: progress passes through untouched;
// a stalled upstream errors the stream and tears down the connection via onIdle.

const chunk = (s: string) => new TextEncoder().encode(s);

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += new TextDecoder().decode(value);
  }
}

describe('withIdleTimeout', () => {
  it('passes all chunks through and closes when the source ends', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk('hello '));
        controller.enqueue(chunk('world'));
        controller.close();
      },
    });
    const onIdle = vi.fn();
    expect(await readAll(withIdleTimeout(source, 1_000, onIdle))).toBe('hello world');
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('errors the stream and reports idle when the source stalls', async () => {
    // First chunk arrives, then the source hangs forever (a dead upstream).
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk('partial'));
      },
    });
    const onIdle = vi.fn();
    await expect(readAll(withIdleTimeout(source, 20, onIdle))).rejects.toThrow(/idle/);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('tears the upstream down when the consumer cancels', async () => {
    // A seek, a skip, or a closed tab: the browser drops the response, and the
    // provider connection behind it has to go with it — cancelling the reader
    // alone leaves that to whatever the fetch implementation happens to do.
    const cancelled = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const abortUpstream = vi.fn();
    await withIdleTimeout(source, 1_000, abortUpstream).cancel('client went away');
    expect(cancelled).toHaveBeenCalledWith('client went away');
    expect(abortUpstream).toHaveBeenCalledOnce();
  });
});
