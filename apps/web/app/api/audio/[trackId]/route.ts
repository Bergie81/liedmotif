// Authorized audio byte serving, scoped owner-or-Lounge-audible
// (the SQL predicate inside `getReadableTrackPlaybackAudio` is the
// whole authorization; this route adds no ownership logic).
//
// The browser references a track's audio by an OPAQUE same-origin path
// (`/api/audio/<trackId>`); this route authenticates the viewer, then serves bytes via
// the cold-start ladder: the DOWNLOADED local-final asset when present, otherwise the
// LAYER-2 provider-stream proxy (decrypt the stored provider URL server-side, fetch
// it, pipe bytes back). Storage keys, filesystem paths, and provider/signed URLs NEVER
// reach the client — only bytes. A track the caller may not read is indistinguishable
// from a missing one (404), so a guessed id reveals nothing.

import type { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { decryptSourceUrl, getReadableTrackPlaybackAudio } from '@liedmotif/db';
import { fetchProviderMedia } from '@liedmotif/providers';
import { uuidSchema } from '@liedmotif/shared';
import {
  audioContentType,
  contentTypeForKey,
  type StorageObjectStat,
  type StorageProvider,
} from '@liedmotif/storage';
import { requireOwnerId } from '@/lib/api-response';
import { encryptionKeyIfConfigured } from '@/lib/credentials';
import { getDb } from '@/lib/db';
import { parseAudioRange } from '@/lib/http-range';
import { getStorageProvider } from '@/lib/providers';
import { withIdleTimeout } from '@/lib/upstream-idle';
import { webStreamFromReadable } from '@/lib/web-stream';

export const dynamic = 'force-dynamic';

const notFound = () => new NextResponse('Not found', { status: 404 });

/**
 * Bounds on the LAYER-2 provider fetch. A whole-request timeout would
 * kill legitimately long tracks mid-stream, so the bounds are on RESPONSIVENESS:
 * headers must arrive promptly, and the body must keep making progress — a dead
 * upstream can then only hold this web request briefly, not indefinitely. The
 * progress bound covers a local-final body read from storage too.
 */
const UPSTREAM_HEADER_TIMEOUT_MS = 15_000;
const UPSTREAM_IDLE_TIMEOUT_MS = 30_000;

/**
 * Cold-start LAYER 2: proxy the provider stream for an owned track whose
 * local final hasn't downloaded yet. The provider URL is decrypted SERVER-SIDE and
 * fetched here; only bytes (and a minimal, safe set of headers) flow back to the
 * client — the provider/signed URL never leaves this process. The client's Range is
 * forwarded so seeking works when the provider supports ranges; otherwise the full
 * body streams (200). Decryption is impossible without the configured key, which a
 * caller cannot distinguish from a missing track (404).
 */
async function proxyProviderStream(
  request: Request,
  encryptedSourceUrl: string,
): Promise<Response> {
  const key = encryptionKeyIfConfigured();
  if (!key) return notFound();
  let sourceUrl: string;
  try {
    sourceUrl = decryptSourceUrl(encryptedSourceUrl, key);
  } catch {
    return notFound();
  }

  const range = request.headers.get('range');
  // One controller covers the whole upstream exchange: it aborts the fetch when
  // headers stall (timer below) and tears down the connection when the BODY stalls
  // (the idle watchdog calls back into it). The egress-guarded fetch enforces
  // http(s), blocks private/metadata hosts (DNS-resolved), and re-validates every
  // redirect hop — a malicious provider URL never reaches an internal host.
  const upstreamAbort = new AbortController();
  const headerTimer = setTimeout(() => upstreamAbort.abort(), UPSTREAM_HEADER_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetchProviderMedia(sourceUrl, {
      ...(range ? { headers: { Range: range } } : {}),
      signal: upstreamAbort.signal,
    });
  } catch {
    // Blocked URL, transport error, or header timeout — all sanitized to a 502.
    return new NextResponse('Bad gateway', { status: 502 });
  } finally {
    clearTimeout(headerTimer);
  }
  // Any response we won't stream must be torn down explicitly — a provider that
  // answers 500 and then trickles an endless error body would otherwise hold the
  // upstream connection OUTSIDE the idle bound below.
  const discardUpstream = () => {
    void upstream.body?.cancel().catch(() => undefined);
    upstreamAbort.abort();
  };
  if (upstream.status === 416) {
    // An out-of-range seek is a benign Range condition — pass it through so the
    // <audio> element can recover, instead of collapsing it to a dead-source 502.
    const headers = new Headers({ 'Cache-Control': 'private, no-store' });
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) headers.set('Content-Range', contentRange);
    discardUpstream();
    return new NextResponse(null, { status: 416, headers });
  }
  if (!upstream.ok || !upstream.body) {
    discardUpstream();
    return new NextResponse('Bad gateway', { status: 502 });
  }

  // Build a fresh, allow-listed header set — never echo provider headers verbatim.
  // That includes the content type: a hostile or MITM'd `text/html` echoed back
  // would execute in the APPLICATION origin on a top-level GET to this
  // same-origin URL, with the session cookie riding along under SameSite=Lax.
  const headers = new Headers({
    'Content-Type': audioContentType(upstream.headers.get('content-type')),
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': upstream.headers.get('accept-ranges') ?? 'bytes',
    // The provider stream is transient (it is later replaced by the local final), so
    // never cache it client-side.
    'Cache-Control': 'private, no-store',
  });
  // fetch transparently decompresses an encoded body while `content-length` still
  // reports the COMPRESSED size — forwarding it would truncate playback mid-track.
  // Forward the length only when no content encoding was applied upstream.
  const contentLength = upstream.headers.get('content-length');
  if (contentLength && !upstream.headers.get('content-encoding')) {
    headers.set('Content-Length', contentLength);
  }
  const contentRange = upstream.headers.get('content-range');
  if (contentRange) headers.set('Content-Range', contentRange);

  const status = upstream.status === 206 ? 206 : 200;
  // Idle-bound the body: a provider that stops sending mid-stream errors this
  // response (and aborts the upstream connection) instead of pinning it forever.
  const body = withIdleTimeout(
    upstream.body as ReadableStream<Uint8Array>,
    UPSTREAM_IDLE_TIMEOUT_MS,
    () => upstreamAbort.abort(),
  );
  return new NextResponse(body, { status, headers });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ trackId: string }> },
): Promise<Response> {
  const viewerUserId = await requireOwnerId(request);
  if (viewerUserId instanceof NextResponse) return viewerUserId;

  const { trackId } = await params;
  // A malformed id is indistinguishable from a missing track (mirrors the tracks
  // route) — and never reaches the uuid-typed DB query (a 500).
  if (!uuidSchema.safeParse(trackId).success) return notFound();
  const audio = await getReadableTrackPlaybackAudio(getDb(), { viewerUserId, trackId });
  // Unknown track OR not readable by the caller → 404 (no cross-owner signal).
  if (!audio) return notFound();

  // Source-pinned serving: `?asset=final|stream` serves EXACTLY that asset or 404s
  // — no ladder fallback — so the deck ladder can infer the committed source kind
  // from which pinned URL succeeded (`HTMLMediaElement` exposes no response
  // headers). An unknown asset value is
  // indistinguishable from a missing asset (404, the route's uniform posture).
  // Unpinned requests keep the existing cold-start ladder unchanged.
  const assetParam = new URL(request.url).searchParams.get('asset');
  if (assetParam !== null) {
    if (assetParam === 'final') {
      return audio.finalStorageKey
        ? serveLocalFinal(request, audio.finalStorageKey, audio.finalMimeType)
        : notFound();
    }
    if (assetParam === 'stream') {
      return audio.providerStreamEncryptedUrl
        ? proxyProviderStream(request, audio.providerStreamEncryptedUrl)
        : notFound();
    }
    return notFound();
  }

  if (!audio.finalStorageKey) {
    // The local final isn't downloaded yet → cold-start layer 2: proxy the provider
    // stream when one exists; otherwise there are no servable bytes.
    if (audio.providerStreamEncryptedUrl) {
      return proxyProviderStream(request, audio.providerStreamEncryptedUrl);
    }
    return notFound();
  }

  return serveLocalFinal(request, audio.finalStorageKey, audio.finalMimeType);
}

/**
 * Weak validator for a local final: an ID3 retag rewrites bytes under the same
 * key, changing both size and mtime, so this invalidates exactly when the
 * bytes change — post-expiry replays of the (typically retagged-once-ever)
 * file revalidate to a 304 instead of re-transferring multiple MB.
 */
function weakAudioEtag(stat: StorageObjectStat): string {
  return `W/"${stat.byteSize}-${stat.updatedAt.getTime()}"`;
}

/** `If-None-Match` list membership under the RFC's weak comparison. */
function anyEtagMatches(header: string, etag: string): boolean {
  if (header.trim() === '*') return true;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, '');
  return header.split(',').some((candidate) => opaque(candidate) === opaque(etag));
}

/** Response headers every local-final answer carries. Per-track bytes are
 *  immutable; private since the route is owner-gated. The stored type is
 *  allow-listed on the way out: a row written from a hostile provider response
 *  must not be served back as markup in the app origin. */
function finalBaseHeaders(contentType: string, stat: StorageObjectStat): Record<string, string> {
  return {
    'Content-Type': audioContentType(contentType),
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600, immutable',
    ETag: weakAudioEtag(stat),
    'Last-Modified': stat.updatedAt.toUTCString(),
  };
}

/**
 * The Range shapes servable in ONE combined read+stat: no Range at all (full
 * body) and an explicit-start single range. Suffix, multi, and malformed
 * ranges fall back to the stat-first path, where `parseAudioRange` stays the
 * single authority on their semantics.
 */
function singleTripRange(header: string | null): { start: number; end?: number } | 'full' | null {
  if (!header) return 'full';
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] === '' ? undefined : Number(match[2]);
  // `\d+` admits digits no file offset can hold, and this path hands the range
  // to storage BEFORE any bounds check — local-fs throws ERR_OUT_OF_RANGE on
  // such a start, S3 stringifies it into a malformed header. The stat-first
  // path knows the total, so only it can answer the 416 they deserve.
  if (!Number.isSafeInteger(start) || (end !== undefined && !Number.isSafeInteger(end))) {
    return null;
  }
  // An inverted range is unsatisfiable (416), which needs the total up front.
  if (end !== undefined && end < start) return null;
  return { start, ...(end !== undefined ? { end } : {}) };
}

/** How a local-final request resolves once the bytes and stat are in hand. */
type FinalAnswer =
  | { kind: 'not_modified' }
  | { kind: 'unsatisfiable' }
  | { kind: 'full'; stream: Readable }
  | { kind: 'range'; stream: Readable; start: number; end: number };

/**
 * Resolve stat + answer in as few storage round trips as the adapter allows.
 * Adapters with the combined read+stat serve the common request shapes (full
 * body, explicit-start range) in ONE trip — every playback seek would
 * otherwise pay a stat plus a read. Conditional requests expect a 304, so they
 * take the stat-first path: a match costs one stat and never opens (only to
 * discard) a body stream. Null means the bytes are gone (e.g. evicted).
 */
async function acquireLocalFinal(
  storage: StorageProvider,
  key: string,
  rangeHeader: string | null,
  ifNoneMatch: string | null,
): Promise<{ stat: StorageObjectStat; answer: FinalAnswer } | null> {
  const readCombined = ifNoneMatch ? undefined : storage.readStreamWithStat?.bind(storage);
  const shape = readCombined ? singleTripRange(rangeHeader) : null;
  if (readCombined && shape !== null) {
    const object = await readCombined(key, shape === 'full' ? undefined : shape);
    if (!object) return null;
    const { stat, stream } = object;
    if (shape === 'full') return { stat, answer: { kind: 'full', stream } };
    if (shape.start >= stat.byteSize) {
      stream.destroy();
      return { stat, answer: { kind: 'unsatisfiable' } };
    }
    const end = Math.min(shape.end ?? stat.byteSize - 1, stat.byteSize - 1);
    return { stat, answer: { kind: 'range', stream, start: shape.start, end } };
  }

  const stat = await storage.stat(key);
  if (!stat) return null;
  // `If-None-Match` is evaluated before Range (RFC 9110): a matching validator
  // short-circuits to 304 with no body, whatever the Range asked for.
  if (ifNoneMatch && anyEtagMatches(ifNoneMatch, weakAudioEtag(stat))) {
    return { stat, answer: { kind: 'not_modified' } };
  }
  const outcome = parseAudioRange(rangeHeader, stat.byteSize);
  if (outcome.kind === 'unsatisfiable') return { stat, answer: outcome };
  if (outcome.kind === 'full') {
    return { stat, answer: { kind: 'full', stream: await storage.readStream(key) } };
  }
  const stream = await storage.readStream(key, { start: outcome.start, end: outcome.end });
  return { stat, answer: { ...outcome, stream } };
}

/**
 * Serve the DOWNLOADED local-final bytes (Range-aware, validator-aware).
 * Shared by the unpinned ladder and the `?asset=final` pin; a row whose bytes
 * are gone (e.g. evicted) is treated as absent.
 */
async function serveLocalFinal(
  request: Request,
  finalStorageKey: string,
  finalMimeType: string | null,
): Promise<Response> {
  const acquired = await acquireLocalFinal(
    getStorageProvider(),
    finalStorageKey,
    request.headers.get('range'),
    request.headers.get('if-none-match'),
  );
  if (!acquired) return notFound();
  const { stat, answer } = acquired;

  const total = stat.byteSize;
  const headers = finalBaseHeaders(
    finalMimeType ?? stat.mimeType ?? contentTypeForKey(finalStorageKey),
    stat,
  );
  // A storage body that stops mid-file (S3 stalled or half-open) must error the
  // response so the player's ladder can recover, rather than leave playback
  // silent behind a request that never ends — and must release its socket.
  const body = (stream: Readable) =>
    withIdleTimeout(webStreamFromReadable(stream), UPSTREAM_IDLE_TIMEOUT_MS, () =>
      stream.destroy(),
    );
  switch (answer.kind) {
    case 'not_modified':
      return new NextResponse(null, { status: 304, headers });
    case 'unsatisfiable':
      return new NextResponse(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${total}` },
      });
    case 'full':
      return new NextResponse(body(answer.stream), {
        status: 200,
        headers: { ...headers, 'Content-Length': String(total) },
      });
    case 'range':
      return new NextResponse(body(answer.stream), {
        status: 206,
        headers: {
          ...headers,
          'Content-Range': `bytes ${answer.start}-${answer.end}/${total}`,
          'Content-Length': String(answer.end - answer.start + 1),
        },
      });
  }
}
