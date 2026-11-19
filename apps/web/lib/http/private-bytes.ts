// The one response builder for owner-only bytes read out of storage.
//
// Every byte-serving route answers through it, so the protections hold wherever
// the next route is copied from rather than depending on each handler spelling
// them out: the declared content type is never sniffed past, the length is
// always declared, and the bytes never enter a shared cache. The Range-aware
// audio route builds its own header set — it carries validators and partial
// responses this shape cannot express.

import type { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { webStreamFromReadable } from '@/lib/http/web-stream';

/**
 * `immutable` is for an id that addresses bytes which never change (a new id is
 * minted whenever they do); `no-store` for anything a later request may see
 * differently.
 */
export type PrivateBytesCache = 'immutable' | 'no-store';

const CACHE_CONTROL: Record<PrivateBytesCache, string> = {
  immutable: 'private, max-age=31536000, immutable',
  'no-store': 'private, no-store',
};

export function privateBytesResponse(args: {
  /** A stream is piped through the cancel-safe adapter, never buffered. */
  body: Readable | Uint8Array;
  contentType: string;
  byteSize: number;
  cache: PrivateBytesCache;
}): NextResponse {
  const body =
    args.body instanceof Uint8Array ? Buffer.from(args.body) : webStreamFromReadable(args.body);
  return new NextResponse(body, {
    headers: {
      'Content-Type': args.contentType,
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': String(args.byteSize),
      'Cache-Control': CACHE_CONTROL[args.cache],
    },
  });
}
