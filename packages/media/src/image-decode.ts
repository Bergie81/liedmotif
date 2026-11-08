// The one sharp entry point for bytes the instance did not produce itself:
// uploads and provider output. Decoding is where a crafted file does its damage
// — a gigapixel "image" is a few kilobytes on disk and gigabytes of RAM once
// decoded — so every such decode carries an explicit pixel ceiling rather than
// sharp's much larger default.

import sharp, { type Sharp } from 'sharp';

/**
 * Decompression-bomb ceiling. Sized to admit the full-resolution modes of
 * current phone cameras — 200 MP sensors emit 16320×12240 ≈ 200 MP, and the
 * browser-side crop degrades to uploading such originals verbatim — while
 * still refusing crafted sources that would decode to multiples of that
 * (a ceiling-sized frame is already ~880 MB of transient RGBA). sharp throws
 * when a source exceeds it, which every caller maps to "not a usable image".
 */
export const MAX_DECODE_PIXELS = 220_000_000;

/** A sharp pipeline over untrusted bytes, bounded by `MAX_DECODE_PIXELS`.
 *  The bytes are wrapped, never copied — decode sources reach hundreds of MB
 *  and no caller mutates them after handing them to a pipeline. */
export function openImage(bytes: Uint8Array): Sharp {
  const input = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return sharp(input, { limitInputPixels: MAX_DECODE_PIXELS });
}

/**
 * What bytes actually decode as, or null when they are not an image at all.
 * The declared `Content-Type` on an upload is a label the client picks, and
 * sharp's buffer input accepts svg, tiff, gif, heif, and raw besides the
 * formats any surface here offers — so this is the only honest statement of
 * what arrived. The header alone answers it: `metadata()` reads no pixels, so
 * bytes a caller goes on to refuse never pay for a decode.
 */
export async function detectImageFormat(bytes: Uint8Array): Promise<string | null> {
  try {
    return (await openImage(bytes).metadata()).format ?? null;
  } catch {
    return null;
  }
}

/**
 * Process-wide libvips thread budget, set ONCE at boot. Unconfigured, every
 * pipeline spawns a per-core thread pool, so N concurrent operations on a small
 * container oversubscribe the CPU and hold hundreds of MB of transient pixel
 * buffers. The web process renders many small tiles at once (bounded by the
 * cover route's semaphore) and wants 1; the worker runs few, large operations
 * and wants a small pool.
 */
export function configureSharpConcurrency(threadsPerOperation: number): void {
  sharp.concurrency(threadsPerOperation);
}
