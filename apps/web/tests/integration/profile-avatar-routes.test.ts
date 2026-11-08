import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { MAX_IMAGE_UPLOAD_BYTES } from '@/lib/image-upload-targets';
import { multipartRequest } from '../helpers/multipart-request';

/** A same-origin API call: the guards look only at the absent `Origin`. */
const apiRequest = () => new Request('http://localhost/api');

const holder = vi.hoisted(() => ({
  authed: true,
  userImage: null as string | null,
  imageWrites: [] as (string | null)[],
  updateShouldFail: false,
  stored: new Map<string, Uint8Array>(),
  deletedKeys: [] as string[],
  queuedKeys: [] as string[],
  /** Which user's `image` currently references each avatar URL (the GET lookup). */
  avatarOwners: new Map<string, string>(),
}));

vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.authed ? { user: { id: 'owner-1' } } : null),
  getAppSession: async () => (holder.authed ? { user: { id: 'owner-1' } } : null),
}));
type UpdateUserInput = { body: { image: string | null }; headers: Headers };
// The user-record seam: image changes must go through Better Auth's updateUser
// (see `updateSessionUserImage` in the route for the cookie-cache invariant),
// and must carry the request headers — without them the endpoint has no session.
vi.mock('@/lib/auth', () => ({
  getAuth: () => ({
    api: {
      updateUser: async ({ body, headers }: UpdateUserInput) => {
        if (!(headers instanceof Headers)) throw new Error('updateUser called without headers');
        if (holder.updateShouldFail) throw new Error('update failed');
        holder.imageWrites.push(body.image);
        holder.userImage = body.image;
        return { status: true };
      },
    },
  }),
}));
vi.mock('@/lib/providers', () => ({
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
    readStream: async (key: string) => Readable.from([Buffer.from(holder.stored.get(key) ?? [])]),
  }),
}));
vi.mock('@liedmotif/db', async (importActual) => {
  const actual = await importActual<typeof import('@liedmotif/db')>();
  return {
    ...actual,
    getUserImage: async () => holder.userImage,
    getAvatarOwnerUserId: async (_db: unknown, imageUrl: string) =>
      holder.avatarOwners.get(imageUrl) ?? null,
    // The replaced avatar's byte-delete is queued transactionally;
    // this suite carries no database, so record the enqueue instead of running it.
    queueOwnerStorageObjectDeletion: async (_db: unknown, args: { storageKey: string }) => {
      holder.queuedKeys.push(args.storageKey);
    },
    // The shared upload intake claims quota room before parsing; this suite
    // carries no database, so admit every write and account nothing.
    getUsageLimits: async () => actual.defaultUsageLimits('UTC'),
    withStorageReservation: <T>(
      _db: unknown,
      _args: unknown,
      write: (stored: (byteSize: number) => void) => Promise<T>,
    ) => write(() => undefined),
  };
});

const avatarRoute = await import('@/app/api/settings/profile/avatar/route');
const imageRoute = await import('@/app/api/avatar/[avatarId]/route');

/** `limitInputPixels: false` so fixtures above the decode ceiling can be synthesized at all. */
async function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 80, b: 200 } },
    limitInputPixels: false,
  })
    .jpeg()
    .toBuffer();
}

function upload(file: File | null): Promise<Response> {
  const form = new FormData();
  if (file) form.set('file', file);
  return avatarRoute.POST(multipartRequest('http://localhost/api/settings/profile/avatar', form));
}

beforeEach(() => {
  holder.authed = true;
  holder.userImage = null;
  holder.imageWrites = [];
  holder.updateShouldFail = false;
  holder.stored.clear();
  holder.deletedKeys = [];
  holder.queuedKeys = [];
  holder.avatarOwners.clear();
});

describe('Profile avatar routes', () => {
  it('stores a square WebP and points user.image at an opaque app URL', async () => {
    const jpeg = await makeJpeg(2000, 1000);
    const response = await upload(
      new File([new Uint8Array(jpeg)], 'me.jpg', { type: 'image/jpeg' }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { imageUrl: string } };
    expect(body.data.imageUrl).toMatch(/^\/api\/avatar\/[0-9a-f-]{36}$/);
    expect(holder.imageWrites).toEqual([body.data.imageUrl]);
    expect(JSON.stringify(body)).not.toContain('avatars/');

    const [storedKey, storedBytes] = [...holder.stored.entries()][0]!;
    expect(storedKey).toBe(`avatars/owner-1/${body.data.imageUrl.split('/').pop()}.webp`);
    expect(Array.from(storedBytes.subarray(0, 4))).toEqual([0x52, 0x49, 0x46, 0x46]);
    expect(Array.from(storedBytes.subarray(8, 12))).toEqual([0x57, 0x45, 0x42, 0x50]);
    const meta = await sharp(Buffer.from(storedBytes)).metadata();
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
  });

  it('requires admin sign-in', async () => {
    holder.authed = false;
    const jpeg = await makeJpeg(32, 32);
    expect(
      (await upload(new File([new Uint8Array(jpeg)], 'me.jpg', { type: 'image/jpeg' }))).status,
    ).toBe(401);
    expect(holder.stored.size).toBe(0);
  });

  it('queues and deletes the replaced avatar bytes after a successful swap', async () => {
    const oldId = '00000000-0000-4000-8000-000000000aaa';
    holder.userImage = `/api/avatar/${oldId}`;
    const jpeg = await makeJpeg(64, 64);
    const response = await upload(
      new File([new Uint8Array(jpeg)], 'me.jpg', { type: 'image/jpeg' }),
    );
    expect(response.status).toBe(200);
    // Queued transactionally (the durable guarantee) AND deleted immediately
    // (the fast path); a storage hiccup on the latter cannot strand the bytes.
    expect(holder.queuedKeys).toEqual([`avatars/owner-1/${oldId}.webp`]);
    expect(holder.deletedKeys).toEqual([`avatars/owner-1/${oldId}.webp`]);
  });

  it('rejects a decompression bomb before it is decoded', async () => {
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
    expect(holder.imageWrites).toEqual([]);
  });

  it('rejects wrong types and undecodable bytes before touching storage or the user row', async () => {
    expect(
      (await upload(new File([new Uint8Array([1, 2, 3])], 'notes.txt', { type: 'text/plain' })))
        .status,
    ).toBe(400);
    expect(
      (await upload(new File([new Uint8Array([1, 2, 3])], 'fake.png', { type: 'image/png' })))
        .status,
    ).toBe(400);
    expect(holder.stored.size).toBe(0);
    expect(holder.imageWrites).toEqual([]);
  });

  it('removes the freshly written bytes when the user-record update fails', async () => {
    holder.updateShouldFail = true;
    const jpeg = await makeJpeg(64, 64);
    await expect(
      upload(new File([new Uint8Array(jpeg)], 'me.jpg', { type: 'image/jpeg' })),
    ).rejects.toThrow('update failed');
    expect(holder.stored.size).toBe(0);
    expect(holder.deletedKeys).toHaveLength(1);
  });

  it('DELETE clears user.image and removes the stored bytes', async () => {
    const oldId = '00000000-0000-4000-8000-000000000bbb';
    holder.userImage = `/api/avatar/${oldId}`;
    holder.stored.set(`avatars/owner-1/${oldId}.webp`, new Uint8Array([1]));
    const response = await avatarRoute.DELETE(apiRequest());
    expect(response.status).toBe(200);
    expect(holder.imageWrites).toEqual([null]);
    expect(holder.queuedKeys).toEqual([`avatars/owner-1/${oldId}.webp`]);
    expect(holder.deletedKeys).toEqual([`avatars/owner-1/${oldId}.webp`]);
  });

  it('serves the live avatar of whichever user references it, with immutable private caching', async () => {
    const avatarId = '00000000-0000-4000-8000-000000000ccc';
    holder.avatarOwners.set(`/api/avatar/${avatarId}`, 'owner-1');
    holder.stored.set(`avatars/owner-1/${avatarId}.webp`, new Uint8Array([9, 9, 9]));
    const response = await imageRoute.GET(new Request('http://localhost'), {
      params: Promise.resolve({ avatarId }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([9, 9, 9]));

    // Another member's avatar serves to the signed-in viewer too — the Lounge
    // attribution read; the key is built from the AVATAR's owner,
    // never from the session user.
    const foreignId = '00000000-0000-4000-8000-000000000eee';
    holder.avatarOwners.set(`/api/avatar/${foreignId}`, 'member-2');
    holder.stored.set(`avatars/member-2/${foreignId}.webp`, new Uint8Array([7]));
    const foreign = await imageRoute.GET(new Request('http://localhost'), {
      params: Promise.resolve({ avatarId: foreignId }),
    });
    expect(foreign.status).toBe(200);
    expect(new Uint8Array(await foreign.arrayBuffer())).toEqual(new Uint8Array([7]));
  });

  it('404s for unreferenced or malformed avatar ids and 401s when signed out', async () => {
    // Bytes still in storage but no user references the id (a replaced
    // avatar): the URL must go dark, not keep serving stale identity.
    const staleId = '00000000-0000-4000-8000-000000000ddd';
    holder.stored.set(`avatars/owner-1/${staleId}.webp`, new Uint8Array([1]));
    expect(
      (
        await imageRoute.GET(new Request('http://localhost'), {
          params: Promise.resolve({ avatarId: staleId }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await imageRoute.GET(new Request('http://localhost'), {
          params: Promise.resolve({ avatarId: '../escape' }),
        })
      ).status,
    ).toBe(404);
    holder.authed = false;
    expect(
      (
        await imageRoute.GET(new Request('http://localhost'), {
          params: Promise.resolve({ avatarId: '00000000-0000-4000-8000-000000000ddd' }),
        })
      ).status,
    ).toBe(401);
  });
});
