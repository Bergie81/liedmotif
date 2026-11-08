// A browser declares `Content-Length` on every multipart upload, and the upload
// routes refuse a body that does not — an undeclared multipart body is either
// hostile or streamed, and the point of the precheck is to answer BEFORE the
// body is buffered. undici computes the length only when it dispatches a
// request, so a hand-built `Request` carries none: declare it here the way the
// browser would.

/** Part framing (boundary, disposition and type headers) per form field. */
const PART_OVERHEAD_BYTES = 256;

/** A multipart POST that declares its size, as the routes require. */
export function multipartRequest(url: string, form: FormData): Request {
  let declared = 0;
  for (const value of form.values()) {
    declared += (value instanceof File ? value.size : String(value).length) + PART_OVERHEAD_BYTES;
  }
  return new Request(url, {
    method: 'POST',
    body: form,
    headers: { 'content-length': String(declared) },
  });
}
