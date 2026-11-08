import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { Id3Artwork } from '@liedmotif/shared';
import { AlbumArtCache, loadAlbumArt, renderAlbumArt, type AlbumArtSource } from './album-art';

const COVER = { coverImageId: 'cover-1', storageKey: 'covers/one.webp', branded: true };
const ART: Id3Artwork = { mediaType: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]) };

/** A stub source plus the media types its renderer was called with. */
function stubSource(overrides: Partial<AlbumArtSource> = {}) {
  const renders: { mediaType: string; branded: boolean }[] = [];
  const source: AlbumArtSource = {
    readCover:
      overrides.readCover ??
      (async (key) => ({ bytes: new Uint8Array([9]), mediaType: `type:${key}` })),
    renderAlbumArt:
      overrides.renderAlbumArt ??
      (async (_bytes, mediaType, branded) => {
        renders.push({ mediaType: mediaType ?? 'none', branded });
        return ART;
      }),
    artworkCache: overrides.artworkCache,
  };
  return { renders, source };
}

describe('loadAlbumArt', () => {
  it('renders the read bytes with the media type the key implies', async () => {
    const { renders, source } = stubSource();
    await expect(loadAlbumArt(source, COVER)).resolves.toEqual(ART);
    expect(renders).toEqual([{ mediaType: 'type:covers/one.webp', branded: true }]);
  });

  it("hands the cover's brandedness to the rendition", async () => {
    const { renders, source } = stubSource();
    await expect(loadAlbumArt(source, { ...COVER, branded: false })).resolves.toEqual(ART);
    expect(renders).toEqual([{ mediaType: 'type:covers/one.webp', branded: false }]);
  });

  it('renders a cover once per id and reuses the rendition', async () => {
    const { renders, source } = stubSource({ artworkCache: new AlbumArtCache() });
    await expect(loadAlbumArt(source, COVER)).resolves.toEqual(ART);
    await expect(loadAlbumArt(source, COVER)).resolves.toEqual(ART);
    expect(renders).toHaveLength(1);
  });

  it('answers null — never throws — when the cover cannot be read', async () => {
    const cache = new AlbumArtCache();
    const { source } = stubSource({
      readCover: async () => {
        throw new Error('storage down');
      },
      artworkCache: cache,
    });
    await expect(loadAlbumArt(source, COVER)).resolves.toBeNull();
    // A failure is never memoized: the next attempt tries the read again.
    expect(cache.get(COVER.coverImageId)).toBeNull();
  });

  it('answers null when the renderer cannot decode the bytes', async () => {
    const { source } = stubSource({ renderAlbumArt: async () => null });
    await expect(loadAlbumArt(source, COVER)).resolves.toBeNull();
  });
});

describe('AlbumArtCache', () => {
  it('evicts the least recently used entry past capacity', () => {
    const cache = new AlbumArtCache(2);
    cache.set('a', ART);
    cache.set('b', ART);
    expect(cache.get('a')).toEqual(ART); // 'a' becomes the most recent
    cache.set('c', ART);
    expect(cache.get('b')).toBeNull();
    expect(cache.get('a')).toEqual(ART);
    expect(cache.get('c')).toEqual(ART);
  });
});

/** A stored-cover-shaped input: square textured WebP at `edge` (never blank). */
async function texturedWebp(edge: number): Promise<Uint8Array> {
  const raw = Buffer.alloc(edge * edge * 3);
  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      const offset = (y * edge + x) * 3;
      raw[offset] = (x * 7 + y * 13) % 256;
      raw[offset + 1] = (x * 3) % 256;
      raw[offset + 2] = (y * 5) % 256;
    }
  }
  return new Uint8Array(
    await sharp(raw, { raw: { width: edge, height: edge, channels: 3 } })
      .webp({ quality: 90 })
      .toBuffer(),
  );
}

/** Mean absolute per-channel difference between the same region of two images. */
async function regionDifference(
  a: Uint8Array,
  b: Uint8Array,
  region: { left: number; top: number; width: number; height: number },
): Promise<number> {
  const extractRegion = (bytes: Uint8Array) =>
    sharp(Buffer.from(bytes)).extract(region).raw().toBuffer({ resolveWithObject: true });
  const [rawA, rawB] = await Promise.all([extractRegion(a), extractRegion(b)]);
  let total = 0;
  for (let i = 0; i < rawA.data.length; i += 1) {
    total += Math.abs(rawA.data[i]! - rawB.data[i]!);
  }
  return total / rawA.data.length;
}

/** Where the badge lives in the overlay asset at 1024 (bottom-left). */
const BADGE_REGION = { left: 110, top: 830, width: 220, height: 80 };
/** Far from the badge; only lossy re-encoding may touch it. */
const FAR_REGION = { left: 600, top: 100, width: 300, height: 300 };

describe('renderAlbumArt (real sharp)', () => {
  it('composites the badge into an unbranded cover before encoding', async () => {
    const input = await texturedWebp(1024);
    const badged = await renderAlbumArt(input, 'image/webp', false);
    const plain = await renderAlbumArt(input, 'image/webp', true);
    expect(badged).not.toBeNull();
    expect(plain).not.toBeNull();
    expect(badged!.mediaType).toBe('image/jpeg');

    const metadata = await sharp(Buffer.from(badged!.bytes)).metadata();
    expect(metadata.width).toBe(1024);
    expect(metadata.height).toBe(1024);

    // Same input, only the branded flag differs: the badge region diverges,
    // the rest is separated by lossy encoding alone.
    expect(await regionDifference(badged!.bytes, plain!.bytes, BADGE_REGION)).toBeGreaterThan(25);
    expect(await regionDifference(badged!.bytes, plain!.bytes, FAR_REGION)).toBeLessThan(5);
  });

  it('passes an already-branded JPEG through byte-identical', async () => {
    const jpeg = new Uint8Array(
      await sharp(Buffer.from(await texturedWebp(256)))
        .jpeg()
        .toBuffer(),
    );
    const rendered = await renderAlbumArt(jpeg, 'image/jpeg', true);
    expect(rendered).toEqual({ mediaType: 'image/jpeg', bytes: jpeg });
  });

  it('re-encodes a JPEG when it still needs the badge', async () => {
    const jpeg = new Uint8Array(
      await sharp(Buffer.from(await texturedWebp(1024)))
        .jpeg()
        .toBuffer(),
    );
    const rendered = await renderAlbumArt(jpeg, 'image/jpeg', false);
    expect(rendered).not.toBeNull();
    expect(Buffer.from(rendered!.bytes).equals(Buffer.from(jpeg))).toBe(false);
  });

  it('caps the badged rendition at the max edge without enlarging small covers', async () => {
    const large = await renderAlbumArt(await texturedWebp(1280), 'image/webp', false);
    const largeMeta = await sharp(Buffer.from(large!.bytes)).metadata();
    expect(largeMeta.width).toBe(1024);
    expect(largeMeta.height).toBe(1024);

    // The composite must size the overlay to the actual decoded image.
    const small = await renderAlbumArt(await texturedWebp(256), 'image/webp', false);
    const smallMeta = await sharp(Buffer.from(small!.bytes)).metadata();
    expect(smallMeta.width).toBe(256);
    expect(smallMeta.height).toBe(256);
  });

  it('returns null on undecodable bytes for both branded states', async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5]);
    await expect(renderAlbumArt(garbage, 'image/webp', false)).resolves.toBeNull();
    await expect(renderAlbumArt(garbage, 'image/webp', true)).resolves.toBeNull();
  });
});
