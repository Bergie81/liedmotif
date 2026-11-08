import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { AVATAR_EDGE, processAvatarUpload } from './avatar-image';

async function makeJpeg(width: number, height: number): Promise<Uint8Array> {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 80, b: 200 } },
  })
    .jpeg()
    .toBuffer();
  return new Uint8Array(buffer);
}

describe('processAvatarUpload', () => {
  it('center-crops any aspect ratio to a square WebP avatar', async () => {
    const processed = await processAvatarUpload(await makeJpeg(2000, 1000));
    expect(processed).not.toBeNull();
    expect(processed!.mediaType).toBe('image/webp');
    const meta = await sharp(Buffer.from(processed!.bytes)).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(AVATAR_EDGE);
    expect(meta.height).toBe(AVATAR_EDGE);
  });

  it('normalizes small uploads to the same square size', async () => {
    const processed = await processAvatarUpload(await makeJpeg(100, 40));
    const meta = await sharp(Buffer.from(processed!.bytes)).metadata();
    expect(meta.width).toBe(AVATAR_EDGE);
    expect(meta.height).toBe(AVATAR_EDGE);
  });

  it('strips all metadata from the stored avatar', async () => {
    const withExif = await sharp(Buffer.from(await makeJpeg(64, 64)))
      .withExif({ IFD0: { Copyright: 'private location data' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const processed = await processAvatarUpload(new Uint8Array(withExif));
    const meta = await sharp(Buffer.from(processed!.bytes)).metadata();
    expect(meta.exif).toBeUndefined();
  });

  it('returns null for bytes that are not a decodable image', async () => {
    expect(await processAvatarUpload(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});
