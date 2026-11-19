import { describe, expect, it, vi } from 'vitest';

// The aggregate bound on upload requests. Every upload surface caps
// one request; the bug these cover is that nothing capped the sum, so enough
// simultaneous legal uploads held enough bodies to restart the web container.
// What matters is that a refused caller never reads its body, and that one
// owner's burst is refused to that owner rather than to everyone.

vi.mock('@/lib/auth/session', () => ({
  getAppSession: async () => null,
  getAdminSession: async () => null,
}));

const { withUploadAdmission } = await import('@/lib/http/request-admission');

/** The per-owner ceiling in `request-admission.ts`. */
const PER_OWNER = 3;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const ok = () => new Response(null, { status: 200 });

/** Occupy the owner's whole per-owner budget; returns the release + settle. */
function saturate(owner: string) {
  const gates = Array.from({ length: PER_OWNER }, () => deferred<Response>());
  const running = gates.map((gate) => withUploadAdmission(owner, () => gate.promise));
  return {
    async release() {
      for (const gate of gates) gate.resolve(ok());
      await Promise.all(running);
    },
  };
}

describe('withUploadAdmission', () => {
  it('refuses one owner past their budget without touching another owner’s', async () => {
    const held = saturate('owner-a');
    await new Promise((resolve) => setImmediate(resolve));

    const refused = await withUploadAdmission('owner-a', async () => ok());
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBeTruthy();

    expect((await withUploadAdmission('owner-b', async () => ok())).status).toBe(200);

    await held.release();
    // The budget is per in-flight request, not a spent allowance.
    expect((await withUploadAdmission('owner-a', async () => ok())).status).toBe(200);
  });

  it('never runs the handler of a refused upload', async () => {
    const held = saturate('owner-c');
    await new Promise((resolve) => setImmediate(resolve));

    const handle = vi.fn(async () => ok());
    const refused = await withUploadAdmission('owner-c', handle);

    expect(refused.status).toBe(429);
    expect(handle).not.toHaveBeenCalled();

    await held.release();
  });
});
