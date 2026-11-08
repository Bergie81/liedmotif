// Shared multipart-image intake for upload routes: admission, form parse, File
// presence, MIME allowlist, byte cap, and the decoded-format gate in one place,
// returning either the accepted image or the 400 response the route should send
// back. The bounds come from the surface's own upload target, so a route can
// never enforce a different contract than the picker that produced the bytes.

import { NextResponse } from 'next/server';
import { detectImageFormat } from '@liedmotif/media';
import { apiError, MULTIPART_OVERHEAD_BYTES, refuseOversizedBody } from '@/lib/api-response';
import {
  MAX_IMAGE_UPLOAD_BYTES,
  isSupportedImageFormat,
  isSupportedImageMimeType,
  megabytes,
} from '@/lib/image-upload-targets';
import { withUploadAdmission } from '@/lib/request-admission';
import { withStorageAdmission, type RecordStoredBytes } from '@/lib/storage-quota';

const TOO_LARGE_MESSAGE = `The image is too large (${megabytes(MAX_IMAGE_UPLOAD_BYTES)} MB max).`;

/**
 * Both halves of the one allowlist — the declared type and the decoded format —
 * answer with this: a part whose label and content disagree is a picker bug,
 * not a distinct user error.
 */
const WRONG_TYPE_MESSAGE = 'Use a JPEG, PNG, or WebP image.';

/**
 * Every image upload route's admission, in one call: a process slot and quota
 * room for what this surface can store, both taken BEFORE the body is read and
 * held for the whole handler. It is one function rather than two nested ones so
 * that a route added later inherits both by writing the wrapper it needs anyway,
 * instead of by remembering that a second one exists.
 */
export function withImageUploadAdmission(
  ownerUserId: string,
  handle: (recordStored: RecordStoredBytes) => Promise<Response>,
): Promise<Response> {
  return withUploadAdmission(ownerUserId, () =>
    withStorageAdmission(ownerUserId, MAX_IMAGE_UPLOAD_BYTES, handle),
  );
}

/**
 * The parsed multipart body of an image upload — the one place an image request
 * body is read, so the ceiling that has to precede that read is stated once. The
 * request-wide ceilings are not stated here: `withImageUploadAdmission` holds
 * those, and has to outlive this call.
 */
export async function readUploadForm(request: Request): Promise<FormData | NextResponse> {
  // The declared-size gate runs FIRST: `formData()` buffers the whole body into
  // heap, so `readImageUpload`'s `file.size` cap is far too late to bound memory.
  const oversized = refuseOversizedBody(request, {
    maxBytes: MAX_IMAGE_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES,
    tooLargeMessage: TOO_LARGE_MESSAGE,
  });
  if (oversized) return oversized;
  try {
    return await request.formData();
  } catch {
    return apiError('validation_error', 'Expected a multipart form upload.');
  }
}

/** An upload that cleared intake — everything a route needs from the part. */
export interface AcceptedImageUpload {
  bytes: Uint8Array;
  /** As the client named it; empty for a part that carried no filename. */
  filename: string;
}

export async function readImageUpload(form: FormData): Promise<AcceptedImageUpload | NextResponse> {
  const file = form.get('file');
  if (!(file instanceof File)) return apiError('validation_error', 'Attach an image file.');
  if (!isSupportedImageMimeType(file.type)) {
    return apiError('validation_error', WRONG_TYPE_MESSAGE);
  }
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) return apiError('validation_error', TOO_LARGE_MESSAGE);
  const bytes = new Uint8Array(await file.arrayBuffer());
  // No decode slot is taken here: reading the header allocates no pixel buffer,
  // which is the only thing the slots exist to bound.
  if (!isSupportedImageFormat(await detectImageFormat(bytes))) {
    return apiError('validation_error', WRONG_TYPE_MESSAGE);
  }
  return { bytes, filename: file.name };
}
