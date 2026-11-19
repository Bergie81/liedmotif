// Member-or-Admin cover byte serving. The browser references a cover by its opaque
// id (`/api/covers/<id>`); this route resolves the storage key server-side and
// streams the bytes from storage. Storage keys and filesystem paths never reach the
// client. Any signed-in profile may ask (`requireBytesOwnerId`), and
// `canReadCover` decides which covers that profile is actually shown.

import type { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import {
  coverRenditionKey,
  getCoverImageById,
  isCoverLoungeVisible,
  PLACEHOLDER_COVER_ID,
  recordCoverRenditionBytes,
} from '@liedmotif/db';
import { renderCoverThumbnail } from '@liedmotif/media';
import { canReadCover, COVER_THUMBNAIL_EDGE, Semaphore, uuidSchema } from '@liedmotif/shared';
import { contentTypeForKey, readAllBytes, type StorageProvider } from '@liedmotif/storage';
import { getDb } from '@/lib/db';
import { privateBytesResponse } from '@/lib/http/private-bytes';
import { getStorageProvider } from '@/lib/providers/providers';
import { requireBytesOwnerId } from '@/lib/http/api-response';

export const dynamic = 'force-dynamic';

const notFound = () => new NextResponse('Not found', { status: 404 });

let placeholderHeal: Promise<void> | null = null;

/**
 * Provision the built-in placeholder cover (row + bytes), at most ONCE per
 * process. The player renders the placeholder for every fresh session and as its
 * generic cover fallback, so an instance whose DB row or `/data` bytes predate it
 * (setup / `db:seed` not re-run) heals here rather than 404ing into an icon.
 * Failure is memoized like success, so a permanently unreadable asset costs one
 * attempt per process instead of one per request — the request itself answers
 * 404 and the UI falls back to its icon, and `db:seed` or a restart is the
 * operator's retry. Lazy import keeps the asset-reading seed module off the
 * route's hot path.
 */
function healPlaceholder(storage: StorageProvider): Promise<void> {
  placeholderHeal ??= (async () => {
    const { ensurePlaceholderCover } = await import('@liedmotif/db/seed');
    await ensurePlaceholderCover(getDb(), storage);
  })().catch(() => undefined);
  return placeholderHeal;
}

/**
 * Load a piece of a cover — its row, its bytes — retrying once behind a heal
 * when the built-in placeholder is the one missing. A missing row and
 * un-ingested bytes are the same answer to the caller (404) and the same fix
 * for the placeholder, so both are loaded through here.
 */
async function withPlaceholderHeal<T>(
  id: string,
  storage: StorageProvider,
  load: () => Promise<T | null>,
): Promise<T | null> {
  const found = await load();
  if (found !== null || id !== PLACEHOLDER_COVER_ID) return found;
  await healPlaceholder(storage);
  return load();
}

/** Cover bytes: per-id bytes never change, so every answer is immutable. */
function coverResponse(
  body: Readable | Uint8Array,
  mimeType: string,
  byteSize: number,
): NextResponse {
  return privateBytesResponse({ body, contentType: mimeType, byteSize, cache: 'immutable' });
}

/**
 * The cached tile rendition, streamed straight from storage — the warm path
 * costs one stat + one read, never touching the original. Null when the
 * rendition is absent (or vanishes between stat and read), so the caller falls
 * back to rendering from the original.
 */
async function serveCachedRendition(
  storage: StorageProvider,
  renditionKey: string,
): Promise<NextResponse | null> {
  try {
    const stat = await storage.stat(renditionKey);
    if (!stat) return null;
    const stream = await storage.readStream(renditionKey);
    return coverResponse(stream, 'image/webp', stat.byteSize);
  } catch {
    return null;
  }
}

/** Concurrent cold requests for the same rendition share one decode+write. */
const inFlightRenders = new Map<string, Promise<Uint8Array | null>>();

/** A fresh grid page fires one request per tile; without a cap they would all
 *  decode full-size originals at once. Pairs with the web process's
 *  `sharp.concurrency(1)`. Waiting is bounded because a refused render is not a
 *  failure here — the caller falls back to the original bytes, so a saturated
 *  process serves a full-size cover instead of holding the request open. */
const renderSlots = new Semaphore(3, { maxWaiting: 12, waitTimeoutMs: 5_000 });

/**
 * Render and cache the tile rendition — derived, write-once bytes. Null when
 * anything fails, so the caller can serve the original: a thumbnail must never
 * break a cover.
 */
function renderRendition(
  storage: StorageProvider,
  coverImageId: string,
  renditionKey: string,
  storageKey: string,
): Promise<Uint8Array | null> {
  const pending = inFlightRenders.get(renditionKey);
  if (pending) return pending;
  const render = renderSlots
    .run(async () => {
      const bytes = await renderCoverThumbnail(
        await readAllBytes(await storage.readStream(storageKey)),
        COVER_THUMBNAIL_EDGE,
      );
      await storage.write({ key: renditionKey, body: bytes, mimeType: 'image/webp' });
      // Accounting for bytes that are already on disk: a failure here must not
      // discard the rendition the request is about to serve.
      await recordCoverRenditionBytes(getDb(), {
        coverImageId,
        byteSize: bytes.byteLength,
      }).catch(() => undefined);
      return bytes;
    })
    .catch((): Uint8Array | null => null)
    .finally(() => inFlightRenders.delete(renditionKey));
  inFlightRenders.set(renditionKey, render);
  return render;
}

/**
 * Unlink a rendition whose cover was reclaimed while it rendered. Nothing else
 * ever could: the orphan sweep nominates covers by ROW, so a rendition written
 * after its row is gone is invisible to every future run. It pairs with the
 * sweep's ordering — that unlinks a rendition only AFTER dropping the row — to
 * leave no gap: a row still here means the sweep's unlink is still ahead of this
 * write, a row already gone means this rendition is ours to remove. A failed
 * unlink only leaks, so it never fails the request.
 */
async function discardRenditionIfReclaimed(
  storage: StorageProvider,
  coverImageId: string,
  renditionKey: string,
): Promise<void> {
  if (await getCoverImageById(getDb(), coverImageId)) return;
  await storage.delete(renditionKey).catch(() => undefined);
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const viewerUserId = await requireBytesOwnerId();
  if (viewerUserId instanceof NextResponse) return viewerUserId;

  const { id: segment } = await params;
  // The reserved `placeholder` segment names the built-in placeholder cover: its
  // uuid lives in the server-only `@liedmotif/db` package, so client components
  // reference the art by this stable alias instead.
  const id = segment === 'placeholder' ? PLACEHOLDER_COVER_ID : segment;
  // A malformed id is indistinguishable from a missing cover (mirrors the tracks
  // route) — and never reaches the uuid-typed DB query (a 500).
  if (!uuidSchema.safeParse(id).success) return notFound();

  const storage = getStorageProvider();
  const cover = await withPlaceholderHeal(id, storage, () => getCoverImageById(getDb(), id));
  if (!cover) return notFound();

  // The placeholder cover is instance-global; every other cover may contain its
  // owner's personal reference imagery and is served to the owner its provenance
  // names — or to a viewer whose Lounge currently exposes it;
  // indistinguishable from missing otherwise. The decision lives in the shared
  // access seam; the Lounge input is resolved lazily so the common own-cover
  // path never pays the extra query.
  const provenanceOwner = (cover.provenance as { ownerUserId?: unknown } | null)?.ownerUserId;
  const provenanceOwnerUserId = typeof provenanceOwner === 'string' ? provenanceOwner : null;
  const coverAccess = { sourceType: cover.sourceType, provenanceOwnerUserId };
  if (!canReadCover(viewerUserId, coverAccess)) {
    const loungeVisible = await isCoverLoungeVisible(getDb(), id, viewerUserId);
    if (!canReadCover(viewerUserId, { ...coverAccess, loungeVisible })) return notFound();
  }

  // `?w=<edge>` (a fixed vocabulary, currently only the tile edge) serves the
  // downscaled rendition: list/grid tiles render at 42–64 CSS px and must not
  // pull the ~150 KB 1024² original each. The cached rendition is tried first,
  // so the warm tile path never stats the original.
  // Shared with cover-byte reclamation: a second key format would strand renditions.
  const renditionKey = coverRenditionKey(id);
  const width = new URL(request.url).searchParams.get('w');
  const wantsThumbnail = width === String(COVER_THUMBNAIL_EDGE);
  if (wantsThumbnail) {
    const cached = await serveCachedRendition(storage, renditionKey);
    if (cached) return cached;
  }

  const stat = await withPlaceholderHeal(id, storage, () => storage.stat(cover.storageKey));
  if (!stat) return notFound();

  if (wantsThumbnail) {
    const thumbnail = await renderRendition(storage, id, renditionKey, cover.storageKey);
    if (thumbnail) {
      await discardRenditionIfReclaimed(storage, id, renditionKey);
      return coverResponse(thumbnail, 'image/webp', thumbnail.byteLength);
    }
  }

  // The cover can be reclaimed between the stat above and this read — answer
  // like any other missing cover instead of 500ing.
  let stream: Readable;
  try {
    stream = await storage.readStream(cover.storageKey);
  } catch {
    return notFound();
  }
  return coverResponse(stream, stat.mimeType ?? contentTypeForKey(cover.storageKey), stat.byteSize);
}
