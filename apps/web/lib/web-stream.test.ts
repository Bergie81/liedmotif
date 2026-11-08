import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { webStreamFromReadable } from './web-stream';

// Every byte route hands a Node Readable to a Response body, and playback cancels
// them constantly (seek, skip, closed tab). Two things must hold on that path: a
// cancel closes what the Readable holds open, and the bytes arrive intact.

describe('webStreamFromReadable', () => {
  it('destroys the source when the consumer cancels mid-stream', async () => {
    // Endless source: the cancel lands while it still has bytes to give, exactly
    // as a seek does — and the storage handle behind it must not survive.
    const source = new Readable({
      read() {
        this.push(Buffer.alloc(8, 1));
      },
    });
    const reader = webStreamFromReadable(source).getReader();
    await reader.read();
    await reader.cancel();

    expect(source.destroyed).toBe(true);
  });

  it('destroys the source when the consumer cancels while a read is still waiting on it', async () => {
    // A stalled storage body (S3 gone quiet mid-file): the pending read never
    // settles on its own, so the cancel must not wait behind it to free the socket.
    const source = new Readable({ read() {} });
    const reader = webStreamFromReadable(source).getReader();
    void reader.read().catch(() => undefined);

    const cancelled = reader.cancel();
    await new Promise((resolve) => setImmediate(resolve));

    expect(source.destroyed).toBe(true);
    await cancelled;
  });

  it('delivers exactly the source bytes, chunk by chunk', async () => {
    // Small buffers are cut from Node's shared 8 KB pool, so a chunk view that
    // forgot its offset and length would serve the pool's contents as audio.
    const chunks = ['first ', 'second ', 'third'].map((text) => Buffer.from(text));
    const reader = webStreamFromReadable(Readable.from(chunks)).getReader();

    const received: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received.push(value);
    }

    expect(Buffer.concat(received).toString()).toBe('first second third');
  });
});
