// Idle watchdog for proxied upstream bodies.
//
// The audio stream proxy pipes a provider body of unknown length — a whole-request
// timeout would kill legitimately long tracks, so the bound is on PROGRESS instead:
// each read of the upstream body must produce a chunk within `idleMs`, or the
// stream errors and the upstream connection is torn down (via `abortUpstream`).
// Client-side backpressure does not tick the clock — the timer only runs while a
// read is actually pending against the upstream.
//
// Every way this stream ends early — the idle trip, or the client dropping the
// response — aborts upstream. Cancelling the reader alone would leave the
// provider connection's fate to the fetch implementation, and a seek or a closed
// tab is the common case on the audio path, not the rare one.

export function withIdleTimeout(
  source: ReadableStream<Uint8Array>,
  idleMs: number,
  abortUpstream: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  // One timer + rejection pair for the stream's whole life, rearmed per read.
  // The trip guard only fires while a read is pending — a stray fire between
  // reads (the timer is left running after a fast chunk) is a no-op, and the
  // next read rearms the fired timer.
  let readPending = false;
  let timer: NodeJS.Timeout | undefined;
  let rejectIdle: (error: Error) => void;
  const idle = new Promise<never>((_, reject) => {
    rejectIdle = reject;
  });
  const trip = () => {
    if (readPending) rejectIdle(new Error('upstream idle timeout'));
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      readPending = true;
      if (timer) timer.refresh();
      else timer = setTimeout(trip, idleMs);
      try {
        const { done, value } = await Promise.race([reader.read(), idle]);
        if (done) {
          clearTimeout(timer);
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        clearTimeout(timer);
        abortUpstream();
        await reader.cancel().catch(() => undefined);
        controller.error(error);
      } finally {
        readPending = false;
      }
    },
    async cancel(reason: unknown) {
      clearTimeout(timer);
      abortUpstream();
      // The abort errors the upstream body, so a cancel racing it can reject —
      // and a teardown that rejects is an unhandled rejection, nothing more.
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}
