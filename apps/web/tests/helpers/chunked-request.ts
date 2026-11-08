// What `Transfer-Encoding: chunked` looks like to a route handler: a body that
// arrives in pieces and declares no length, so the app's byte ceiling can only
// be enforced while it streams. `pulled` reports how much of it the reader
// actually asked for, which is what tells an abandoned read apart from one that
// buffered everything and refused afterwards.

/** A chunked JSON POST, plus the count of chunks the reader has taken. */
export function chunkedJsonRequest(
  chunks: readonly Uint8Array[],
  url = 'http://localhost/api/thing',
): { request: Request; pulled: () => number } {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[pulled];
      if (!next) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(next);
    },
  });
  const request = new Request(url, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  return { request, pulled: () => pulled };
}

/** `count` chunks of `bytes` each — a body whose only property is its size. */
export function fillerChunks(count: number, bytes: number): Uint8Array[] {
  return Array.from({ length: count }, () => new Uint8Array(bytes));
}
