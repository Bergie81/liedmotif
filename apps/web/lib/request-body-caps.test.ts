import { describe, expect, it, vi } from 'vitest';
import { chunkedJsonRequest, fillerChunks } from '../tests/helpers/chunked-request';

// An oversized body must be refused BEFORE it is buffered into heap:
// `request.formData()` and `request.json()` materialize the whole body first, so
// a size check that runs after one of them lets a multi-gigabyte file pick OOM
// the web process. These tests pin that ordering — a request whose parse would
// throw must still answer 413 — and, for JSON, that a body which declares no
// length is counted as it streams instead.

vi.mock('@/lib/session', () => ({
  getAppSession: async () => null,
  getAdminSession: async () => null,
}));

const { MAX_JSON_BODY_BYTES, parseJsonBody, readJsonObjectBody } =
  await import('@/lib/api-response');
const { readImageUpload, readUploadForm } = await import('@/lib/image-upload');
const { MAX_IMAGE_UPLOAD_BYTES } = await import('@/lib/image-upload-targets');

const anySchema = { safeParse: (data: unknown) => ({ success: true as const, data }) };

/** A request whose body parse throws — reached only if the precheck let it by. */
function unparseableRequest(contentLength: number | null): Request {
  const refuse = () => {
    throw new Error('the body must not be read');
  };
  return {
    headers: new Headers(contentLength === null ? {} : { 'content-length': String(contentLength) }),
    body: null,
    text: refuse,
    json: refuse,
    formData: refuse,
  } as unknown as Request;
}

async function messageOf(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { message: string } };
  return body.error.message;
}

describe('parseJsonBody body cap', () => {
  it('refuses a body declaring more than the cap without reading it', async () => {
    const result = await parseJsonBody(
      unparseableRequest(MAX_JSON_BODY_BYTES + 1),
      anySchema,
      'invalid',
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  });

  it('parses a body inside the cap', async () => {
    const request = new Request('http://localhost/api/thing', {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
      headers: { 'content-type': 'application/json', 'content-length': '7' },
    });
    expect(await parseJsonBody(request, anySchema, 'invalid')).toEqual({ a: 1 });
  });

  it('stops reading a chunked body once it passes the cap', async () => {
    // No `Content-Length` to precheck, so the cap can only be enforced while the
    // body streams in — buffering it whole and refusing afterwards is the heap
    // amplification this guards against.
    const CHUNKS = 24;
    const { request, pulled } = chunkedJsonRequest(fillerChunks(CHUNKS, 64 * 1024));

    const result = await parseJsonBody(request, anySchema, 'invalid');

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
    expect(pulled()).toBeLessThan(CHUNKS);
  });

  it('parses a chunked body inside the cap, characters split across chunks and all', async () => {
    // `{"a":"é"}` cut mid-`é`: a decoder run per chunk instead of across the
    // stream turns the halves into replacement characters and silently changes
    // the value the route stores.
    const bytes = new TextEncoder().encode(JSON.stringify({ a: 'é' }));
    const { request } = chunkedJsonRequest([bytes.slice(0, 7), bytes.slice(7)]);

    expect(await parseJsonBody(request, anySchema, 'invalid')).toEqual({ a: 'é' });
  });
});

describe('readJsonObjectBody', () => {
  it('refuses an oversized body in the plain error shape its routes answer in', async () => {
    // These routes' clients read `error` as a string; the envelope's nested
    // error object would reach the settings screens as no message at all.
    const result = await readJsonObjectBody(unparseableRequest(MAX_JSON_BODY_BYTES + 1));

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
    expect(await (result as Response).json()).toEqual({
      ok: false,
      error: expect.stringContaining('too large'),
    });
  });

  it('refuses a body that is not a plain object', async () => {
    // The routes index the result by key; an array or a bare primitive reaching
    // that code would be read as an object with every field absent.
    const request = new Request('http://localhost/api/thing', {
      method: 'POST',
      body: JSON.stringify([{ name: 'x' }]),
      headers: { 'content-type': 'application/json' },
    });
    const result = await readJsonObjectBody(request);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
  });
});

describe('readUploadForm declared-length cap', () => {
  it('refuses a multipart body declaring more than the image cap', async () => {
    const result = await readUploadForm(unparseableRequest(MAX_IMAGE_UPLOAD_BYTES * 30));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
    expect(await messageOf(result as Response)).toContain('too large');
  });

  it('refuses an upload that declares no length at all', async () => {
    const result = await readUploadForm(unparseableRequest(null));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  });

  it('accepts an upload inside the cap', async () => {
    // A real 1×1 PNG: intake also gates on the DECODED format, so placeholder
    // bytes with an image label would be refused for a different reason.
    const png = new Uint8Array(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    const source = new FormData();
    source.append('file', new File([png], 'a.png', { type: 'image/png' }));
    const encoded = new Request('http://localhost/api/upload', { method: 'POST', body: source });
    const bytes = await encoded.arrayBuffer();
    const request = new Request('http://localhost/api/upload', {
      method: 'POST',
      body: bytes,
      headers: {
        'content-type': encoded.headers.get('content-type')!,
        'content-length': String(bytes.byteLength),
      },
    });
    const form = await readUploadForm(request);
    expect(form).not.toBeInstanceOf(Response);
    const upload = await readImageUpload(form as FormData);
    expect(upload).not.toBeInstanceOf(Response);
    expect((upload as { bytes: Uint8Array }).bytes).toEqual(png);
  });
});
