import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { MAX_IMAGE_UPLOAD_BYTES } from '@/lib/media/image-upload-targets';
import { multipartRequest } from '../helpers/multipart-request';

const PERSON_ID = '00000000-0000-4000-8000-000000000111';
const PHOTO_ID = '00000000-0000-4000-8000-000000000222';

const holder = vi.hoisted(() => ({
  authed: true,
  insertResult: null as unknown,
  inserted: [] as unknown[],
  deletedPhotos: [] as unknown[],
  stored: new Map<string, Uint8Array>(),
  deletedKeys: [] as string[],
  photo: null as Record<string, unknown> | null,
}));

vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.authed ? { user: { id: 'owner-1' } } : null),
  getAppSession: async () => (holder.authed ? { user: { id: 'owner-1' } } : null),
}));
vi.mock('@/lib/providers/providers', () => ({
  getStorageProvider: () => ({
    providerKey: 'local-fs',
    write: async (input: { key: string; body: Uint8Array }) => {
      holder.stored.set(input.key, input.body);
      return { key: input.key, byteSize: input.body.length, updatedAt: new Date() };
    },
    delete: async (key: string) => {
      holder.deletedKeys.push(key);
      holder.stored.delete(key);
    },
    stat: async (key: string) =>
      holder.stored.has(key)
        ? { key, byteSize: holder.stored.get(key)!.length, updatedAt: new Date() }
        : null,
    readStream: async (key: string) => Readable.from(holder.stored.get(key) ?? []),
  }),
}));
vi.mock('@liedmotif/db', async (importActual) => {
  const actual = await importActual<typeof import('@liedmotif/db')>();
  return {
    ...actual,
    // The shared upload intake claims quota room before parsing; these suites
    // carry no database, so admit every write and account nothing.
    getUsageLimits: async () => actual.defaultUsageLimits('UTC'),
    withStorageReservation: <T>(
      _db: unknown,
      _args: unknown,
      write: (stored: (byteSize: number) => void) => Promise<T>,
    ) => write(() => undefined),
    listPersonReferencePhotos: async () => (holder.photo ? [holder.photo] : []),
    getPersonReferencePhoto: async () => holder.photo,
    insertPersonReferencePhoto: async (_db: unknown, input: unknown) => {
      holder.inserted.push(input);
      return (
        holder.insertResult ?? {
          inserted: true,
          photo: {
            ...(input as Record<string, unknown>),
            originalFilename: null,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
        }
      );
    },
    deletePersonReferencePhoto: async (_db: unknown, input: unknown) => {
      holder.deletedPhotos.push(input);
      return holder.photo;
    },
  };
});

const collectionRoute = await import('@/app/api/settings/people/[id]/photos/route');
const photoRoute = await import('@/app/api/settings/people/[id]/photos/[photoId]/route');
const imageRoute = await import('@/app/api/settings/people/[id]/photos/[photoId]/image/route');

/** `limitInputPixels: false` so fixtures above the decode ceiling can be synthesized at all. */
async function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } },
    limitInputPixels: false,
  })
    .jpeg()
    .toBuffer();
}

async function uploadJpeg(width: number, height: number): Promise<Response> {
  const jpeg = await makeJpeg(width, height);
  return upload(new File([new Uint8Array(jpeg)], 'portrait.jpg', { type: 'image/jpeg' }));
}

/** The geometry of the single object the upload wrote. */
async function storedSize(): Promise<{ width?: number; height?: number; format?: string }> {
  const stored = [...holder.stored.values()][0]!;
  return sharp(Buffer.from(stored)).metadata();
}

function upload(file: File | null): Promise<Response> {
  const form = new FormData();
  if (file) form.set('file', file);
  return collectionRoute.POST(
    multipartRequest(`http://localhost/api/settings/people/${PERSON_ID}/photos`, form),
    { params: Promise.resolve({ id: PERSON_ID }) },
  );
}

beforeEach(() => {
  holder.authed = true;
  holder.insertResult = null;
  holder.inserted = [];
  holder.deletedPhotos = [];
  holder.stored.clear();
  holder.deletedKeys = [];
  holder.photo = null;
});

describe('Person reference photo routes', () => {
  it('stores a processed WebP under an implicit Person association and returns only an opaque URL', async () => {
    const response = await uploadJpeg(2000, 1000);

    expect(response.status).toBe(200);
    expect(holder.inserted[0]).toMatchObject({ ownerUserId: 'owner-1', personId: PERSON_ID });
    const body = (await response.json()) as { data: { photo: Record<string, unknown> } };
    expect(body.data.photo).toMatchObject({
      personId: PERSON_ID,
      mediaType: 'image/webp',
      // The widest 3:4 portrait a 2000×1000 frame contains, at its own scale.
      width: 750,
      height: 1000,
      imageUrl: `/api/settings/people/${PERSON_ID}/photos/${body.data.photo.id}/image`,
    });
    expect(JSON.stringify(body)).not.toContain('storageKey');
    expect(JSON.stringify(body)).not.toContain('person-references/');

    const stored = [...holder.stored.values()][0]!;
    expect(Array.from(stored.subarray(0, 4))).toEqual([0x52, 0x49, 0x46, 0x46]);
    expect(Array.from(stored.subarray(8, 12))).toEqual([0x57, 0x45, 0x42, 0x50]);
  });

  it('center-crops any aspect to 3:4 and caps the stored height at 2048', async () => {
    expect((await uploadJpeg(3000, 4000)).status).toBe(200);
    expect(await storedSize()).toMatchObject({ width: 1536, height: 2048, format: 'webp' });

    holder.stored.clear();
    // Taller than 3:4 — the crop takes the full width, the cap the height.
    expect((await uploadJpeg(4000, 6000)).status).toBe(200);
    expect(await storedSize()).toMatchObject({ width: 1536, height: 2048 });
  });

  it('never upscales a source smaller than the cap', async () => {
    expect((await uploadJpeg(100, 100)).status).toBe(200);
    expect(await storedSize()).toMatchObject({ width: 75, height: 100 });
  });

  it('frames an EXIF-rotated source by the pixels the owner sees', async () => {
    // Stored landscape, tagged to display as a 1200×1600 portrait: framing it by
    // the STORED dimensions would needlessly shrink the rendition.
    const sideways = await sharp({
      create: { width: 1600, height: 1200, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const response = await upload(
      new File([new Uint8Array(sideways)], 'sideways.jpg', { type: 'image/jpeg' }),
    );
    expect(response.status).toBe(200);
    expect(await storedSize()).toMatchObject({ width: 1200, height: 1600 });
  });

  it('refuses a decompression bomb before it is decoded', async () => {
    // 240 MP (over MAX_DECODE_PIXELS): a megabyte-sized file that would decode
    // to roughly a gigabyte.
    const bomb = await makeJpeg(16000, 15000);
    // Under the route's byte cap, so the refusal below is the pixel limit.
    expect(bomb.length).toBeLessThan(MAX_IMAGE_UPLOAD_BYTES);
    const response = await upload(
      new File([new Uint8Array(bomb)], 'bomb.jpg', { type: 'image/jpeg' }),
    );
    expect(response.status).toBe(400);
    expect(holder.stored.size).toBe(0);
    expect(holder.inserted).toEqual([]);
  });

  it('rejects invalid images before persistence', async () => {
    expect(
      (await upload(new File([new Uint8Array([1, 2, 3])], 'notes.txt', { type: 'text/plain' })))
        .status,
    ).toBe(400);
    expect(
      (await upload(new File([new Uint8Array([1, 2, 3])], 'fake.png', { type: 'image/png' })))
        .status,
    ).toBe(400);
    expect(holder.stored.size).toBe(0);
    expect(holder.inserted).toEqual([]);
  });

  it.each([
    ['person_limit_reached', 'This Person already has 3 reference photos.'],
    ['owner_limit_reached', 'You already have 18 Person reference photos.'],
  ])('returns explicit cap feedback for %s and removes refused bytes', async (reason, message) => {
    holder.insertResult = { inserted: false, reason };
    const jpeg = await makeJpeg(32, 32);
    const response = await upload(
      new File([new Uint8Array(jpeg)], 'portrait.jpg', { type: 'image/jpeg' }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { message } });
    expect(holder.deletedKeys).toHaveLength(1);
    expect(holder.stored.size).toBe(0);
  });

  it('lists per-Person and total cap feedback without exposing another owner', async () => {
    const response = await collectionRoute.GET(new Request('http://localhost'), {
      params: Promise.resolve({ id: PERSON_ID }),
    });
    expect(await response.json()).toMatchObject({
      data: { items: [], personCount: 0, totalCount: 0, maxPerPerson: 3, maxTotal: 18 },
    });
    holder.authed = false;
    expect(
      (
        await collectionRoute.GET(new Request('http://localhost'), {
          params: Promise.resolve({ id: PERSON_ID }),
        })
      ).status,
    ).toBe(401);
  });

  it('serves bytes only for an authorized photo associated with the path Person', async () => {
    const storageKey = 'private/person.webp';
    holder.stored.set(storageKey, new Uint8Array([1, 2, 3]));
    holder.photo = {
      id: PHOTO_ID,
      personId: PERSON_ID,
      ownerUserId: 'owner-1',
      storageKey,
      mediaType: 'image/webp',
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const response = await imageRoute.GET(new Request('http://localhost'), {
      params: Promise.resolve({ id: PERSON_ID, photoId: PHOTO_ID }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    // Declared route-locally: the byte routes never depend on the global header
    // set to stop a stored image being sniffed into something executable.
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');

    holder.photo = { ...holder.photo, personId: '00000000-0000-4000-8000-000000000999' };
    expect(
      (
        await imageRoute.GET(new Request('http://localhost'), {
          params: Promise.resolve({ id: PERSON_ID, photoId: PHOTO_ID }),
        })
      ).status,
    ).toBe(404);
  });

  it('deletes through the owner-and-Person scoped repository and removes bytes best-effort', async () => {
    const storageKey = 'private/person.webp';
    holder.photo = { id: PHOTO_ID, personId: PERSON_ID, storageKey };
    const response = await photoRoute.DELETE(new Request('http://localhost'), {
      params: Promise.resolve({ id: PERSON_ID, photoId: PHOTO_ID }),
    });
    expect(response.status).toBe(200);
    expect(holder.deletedPhotos).toEqual([
      { ownerUserId: 'owner-1', personId: PERSON_ID, photoId: PHOTO_ID },
    ]);
    expect(holder.deletedKeys).toEqual([storageKey]);
  });
});
