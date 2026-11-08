import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PersonLimitError, PersonNameConflictError } from '@liedmotif/db';

/** A same-origin API call: the guards look only at the absent `Origin`. */
const apiRequest = () => new Request('http://localhost/api');

const OWNER_PERSON_ID = '11111111-1111-4111-8111-111111111111';
const ORDINARY_PERSON_ID = '22222222-2222-4222-8222-222222222222';

const holder = vi.hoisted(() => ({
  authed: true,
  people: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      ownerUserId: 'owner-1',
      role: 'owner',
      name: 'John',
      nameMatchKey: 'john',
      about: 'Trail runner.',
      sortOrder: 0,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    },
  ],
  createError: null as Error | null,
  updateResult: null as unknown,
  deleteResult: 'deleted' as 'deleted' | 'not_found' | 'owner',
  calls: [] as Array<{ operation: string; input?: unknown }>,
}));

vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.authed ? { user: { id: 'owner-1' } } : null),
  getAppSession: async () => (holder.authed ? { user: { id: 'owner-1' } } : null),
}));
vi.mock('@liedmotif/db', async (importActual) => {
  const actual = await importActual<typeof import('@liedmotif/db')>();
  return {
    ...actual,
    ensureOwnerPerson: async () => holder.people[0],
    listPeople: async () => holder.people,
    getCoverReferenceFrequency: async () => 'seldom',
    createPerson: async (_db: unknown, input: unknown) => {
      holder.calls.push({ operation: 'create', input });
      if (holder.createError) throw holder.createError;
      return {
        ...holder.people[0],
        id: '22222222-2222-4222-8222-222222222222',
        role: 'ordinary',
        sortOrder: 1,
        ...(input as object),
      };
    },
    updatePerson: async (_db: unknown, input: unknown) => {
      holder.calls.push({ operation: 'update', input });
      return holder.updateResult;
    },
    deletePerson: async (_db: unknown, input: unknown) => {
      holder.calls.push({ operation: 'delete', input });
      return holder.deleteResult;
    },
    updateCoverReferenceFrequency: async (_db: unknown, ownerUserId: string, frequency: string) => {
      holder.calls.push({ operation: 'frequency', input: { ownerUserId, frequency } });
    },
  };
});

const collectionRoute = await import('@/app/api/settings/people/route');
const personRoute = await import('@/app/api/settings/people/[id]/route');

function request(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  holder.authed = true;
  holder.createError = null;
  holder.updateResult = { ...holder.people[0], name: 'Tom', about: '', role: 'owner' };
  holder.deleteResult = 'deleted';
  holder.calls = [];
});

describe('/api/settings/people', () => {
  it('returns private Person summaries and the relocated fallback frequency', async () => {
    const response = await collectionRoute.GET(apiRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      people: [{ id: OWNER_PERSON_ID, role: 'owner', name: 'John', about: 'Trail runner.' }],
      coverReferenceFrequency: 'seldom',
      maxPeople: 6,
    });
  });

  it('requires admin auth for reads and every mutation', async () => {
    holder.authed = false;
    expect((await collectionRoute.GET(apiRequest())).status).toBe(401);
    expect((await collectionRoute.POST(request('POST', '/api/settings/people', {}))).status).toBe(
      401,
    );
    expect(
      (
        await personRoute.PATCH(
          request('PATCH', `/api/settings/people/${ORDINARY_PERSON_ID}`, {}),
          {
            params: Promise.resolve({ id: ORDINARY_PERSON_ID }),
          },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await personRoute.DELETE(request('DELETE', `/api/settings/people/${ORDINARY_PERSON_ID}`), {
          params: Promise.resolve({ id: ORDINARY_PERSON_ID }),
        })
      ).status,
    ).toBe(401);
  });

  it('creates bounded People and maps cap and canonical-name conflicts safely', async () => {
    const created = await collectionRoute.POST(
      request('POST', '/api/settings/people', { name: '  Julia  ', about: '  Painter.  ' }),
    );
    expect(created.status).toBe(201);
    expect(holder.calls[0]).toEqual({
      operation: 'create',
      input: { ownerUserId: 'owner-1', name: 'Julia', about: 'Painter.' },
    });

    holder.createError = new PersonLimitError();
    expect(
      (
        await collectionRoute.POST(
          request('POST', '/api/settings/people', { name: 'Another', about: '' }),
        )
      ).status,
    ).toBe(409);
    holder.createError = new PersonNameConflictError();
    const duplicate = await collectionRoute.POST(
      request('POST', '/api/settings/people', { name: 'JULIA', about: '' }),
    );
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error).toBe('Each Person needs a unique name.');
  });

  it('updates only through an owner-scoped id and refuses owner deletion', async () => {
    const updated = await personRoute.PATCH(
      request('PATCH', `/api/settings/people/${ORDINARY_PERSON_ID}`, {
        name: 'Julia',
        about: 'Cyclist.',
      }),
      { params: Promise.resolve({ id: ORDINARY_PERSON_ID }) },
    );
    expect(updated.status).toBe(200);
    expect(holder.calls[0]).toEqual({
      operation: 'update',
      input: {
        ownerUserId: 'owner-1',
        personId: ORDINARY_PERSON_ID,
        name: 'Julia',
        about: 'Cyclist.',
      },
    });

    holder.deleteResult = 'owner';
    const deleted = await personRoute.DELETE(
      request('DELETE', `/api/settings/people/${OWNER_PERSON_ID}`),
      { params: Promise.resolve({ id: OWNER_PERSON_ID }) },
    );
    expect(deleted.status).toBe(400);
    expect((await deleted.json()).error).toBe('The owner Person cannot be deleted.');
  });

  it('returns not found for malformed Person ids without querying the repository', async () => {
    const patched = await personRoute.PATCH(
      request('PATCH', '/api/settings/people/not-a-uuid', { name: 'Julia', about: '' }),
      { params: Promise.resolve({ id: 'not-a-uuid' }) },
    );
    const deleted = await personRoute.DELETE(request('DELETE', '/api/settings/people/not-a-uuid'), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    });

    expect(patched.status).toBe(404);
    expect(deleted.status).toBe(404);
    expect(holder.calls).toEqual([]);
  });

  it('updates the no-name owner fallback independently of Profile', async () => {
    const response = await collectionRoute.POST(
      request('POST', '/api/settings/people', { coverReferenceFrequency: 'never' }),
    );
    expect(response.status).toBe(200);
    expect(holder.calls).toEqual([
      { operation: 'frequency', input: { ownerUserId: 'owner-1', frequency: 'never' } },
    ]);
  });
});
