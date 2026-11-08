// Byte bounds on what a provider is allowed to send back.
//
// A provider response is untrusted input the same way an upload is, and the
// upload side already refuses before buffering. Reading a body whole and
// checking its size afterwards is not a bound at all: by the time the check
// runs, the bytes are in heap (an image) or through the disk reserve (audio),
// and the only thing standing between a hostile or compromised provider on a
// fast link and the process is the request timeout.
//
// So the ceiling is applied twice. A DECLARED oversize length is refused before
// the body is touched, and the body itself flows through a counting stream that
// errors — and therefore cancels the upstream fetch — the moment it goes past.
// The declaration is a hint (it may be absent, wrong, or the compressed size);
// the count is the authority.

/** A provider response that exceeded the caller's ceiling. */
export class ProviderResponseTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Provider response exceeded ${maxBytes} bytes.`);
    this.name = 'ProviderResponseTooLargeError';
  }
}

/** The body size the response declares, or null when it declares none. */
export function declaredResponseBytes(response: Response): number | null {
  const header = response.headers.get('content-length');
  if (header === null) return null;
  const declared = Number(header);
  return Number.isSafeInteger(declared) && declared >= 0 ? declared : null;
}

/**
 * The response body as a stream that carries at most `maxBytes`, throwing
 * `ProviderResponseTooLargeError` at the declaration or on the chunk that
 * crosses the line. Erroring the stream is what tears the upstream connection
 * down, so an over-long body is never drained to completion.
 */
export function boundedResponseStream(
  response: Response,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  const declared = declaredResponseBytes(response);
  if (declared !== null && declared > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new ProviderResponseTooLargeError(maxBytes);
  }
  const body = response.body;
  if (!body) throw new TypeError('Provider response carried no body.');
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) throw new ProviderResponseTooLargeError(maxBytes);
        controller.enqueue(chunk);
      },
    }),
  );
}

/** The whole response body, refused past `maxBytes` rather than buffered first. */
export async function readBoundedResponseBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const bounded = boundedResponseStream(response, maxBytes);
  return new Uint8Array(await new Response(bounded).arrayBuffer());
}

/**
 * `response.json()` under a ceiling. Providers that inline an image as base64
 * make the JSON body itself the fat one, so the bound has to be here rather
 * than on any field inside it.
 */
export async function readBoundedResponseJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const bytes = await readBoundedResponseBytes(response, maxBytes);
  return JSON.parse(new TextDecoder().decode(bytes));
}
