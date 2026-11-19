import type { Readable } from 'node:stream';

/**
 * Pull-based Readable → web stream conversion. `Readable.toWeb` pushes from a
 * `data` listener and can enqueue into an already-closed controller when the
 * client cancels mid-stream (an uncaught `ERR_INVALID_STATE`); pulling through
 * the async iterator keeps backpressure and makes cancel teardown-safe. Cancel
 * destroys the source directly, closing anything it still holds open: the
 * iterator's `return` alone queues behind a pending `next()`, so a source that
 * has stopped producing (a stalled S3 body) would keep its socket. `onCancel`
 * covers what destroying the source cannot reach — a producer with its own work
 * queue behind the stream, say.
 */
export function webStreamFromReadable(
  readable: Readable,
  onCancel?: () => void,
): ReadableStream<Uint8Array> {
  const iterator = readable[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      onCancel?.();
      readable.destroy();
      await iterator.return?.();
    },
  });
}
