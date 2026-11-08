import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import { createSession, createUser, GENERATION_FIXTURE_TABLES } from './test-fixtures';
import { applyLoopLease, hasLiveLoopLease } from './loop-lease-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

// The repeat-one loop LEASE. Playback traffic is
// fire-and-forget and reorderable, so these tests exercise the protocol rules:
// per-client monotonic epochs, reordering safety (a delayed renew/acquire can
// never resurrect a newer release), per-client independence (a foreign tab can
// neither release nor displace another tab's hold), and expiry lapse.
describeIfDb('loop-lease repo', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-loop-lease-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, [...GENERATION_FIXTURE_TABLES, 'session_loop_leases']);
  });

  const t0 = new Date('2026-07-10T12:00:00Z');
  const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

  async function seedSession(): Promise<{ ownerUserId: string; sessionId: string }> {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    return { ownerUserId, sessionId };
  }

  function op(
    base: { ownerUserId: string; sessionId: string },
    action: 'acquire' | 'renew' | 'release',
    args: { clientId?: string; epoch: number; now?: Date },
  ) {
    return applyLoopLease(ctx.db, {
      ...base,
      clientId: args.clientId ?? 'tab-a',
      epoch: args.epoch,
      action,
      now: args.now ?? t0,
    });
  }

  it('acquire creates an acknowledged hold; renew extends it', async () => {
    const base = await seedSession();

    const acquired = await op(base, 'acquire', { epoch: 1 });
    expect(acquired).toMatchObject({
      ok: true,
      applied: true,
      state: { held: true, lease: { epoch: 1, released: false } },
    });

    const renewed = await op(base, 'renew', { epoch: 2, now: at(30) });
    if (!renewed.ok) throw new Error('unreachable');
    expect(renewed.applied).toBe(true);
    expect(renewed.state.lease!.expiresAt.getTime()).toBeGreaterThan(
      acquired.ok ? acquired.state.lease!.expiresAt.getTime() : 0,
    );
    expect(await hasLiveLoopLease(ctx.db, { sessionId: base.sessionId, now: at(31) })).toBe(true);
  });

  it('reordered release-then-renew: the delayed renew can never resurrect the hold', async () => {
    const base = await seedSession();
    await op(base, 'acquire', { epoch: 1 });
    // The client sent renew(epoch 5) then release(epoch 6); the network delivers
    // the RELEASE first...
    const release = await op(base, 'release', { epoch: 6, now: at(10) });
    expect(release).toMatchObject({ ok: true, applied: true, state: { held: false } });

    // ...and the stale renew afterwards. It must be rejected: the row survived the
    // release with epoch 6, so renew(5) is out of order.
    const staleRenew = await op(base, 'renew', { epoch: 5, now: at(11) });
    expect(staleRenew).toMatchObject({
      ok: true,
      applied: false,
      state: { held: false, lease: { epoch: 6, released: true } },
    });
    expect(await hasLiveLoopLease(ctx.db, { sessionId: base.sessionId, now: at(12) })).toBe(false);
  });

  it('release-before-FIRST-acquire leaves a tombstone: the delayed acquire cannot resurrect', async () => {
    const base = await seedSession();
    // The user toggled on then immediately off; the network delivers the
    // RELEASE (epoch 2) before the first ACQUIRE (epoch 1) ever arrives. The
    // release must record a released tombstone even though no row exists yet…
    const release = await op(base, 'release', { epoch: 2 });
    expect(release).toMatchObject({
      ok: true,
      applied: true,
      state: { held: false, lease: { epoch: 2, released: true } },
    });

    // …so the delayed lower-epoch acquire changes nothing: no 60 s ghost hold.
    const delayed = await op(base, 'acquire', { epoch: 1, now: at(1) });
    expect(delayed).toMatchObject({ ok: true, applied: false, state: { held: false } });
    expect(await hasLiveLoopLease(ctx.db, { sessionId: base.sessionId, now: at(2) })).toBe(false);

    // A genuinely newer toggle-on still re-acquires.
    const fresh = await op(base, 'acquire', { epoch: 3, now: at(3) });
    expect(fresh).toMatchObject({ ok: true, applied: true, state: { held: true } });
  });

  it('a delayed stale ACQUIRE after a newer release is rejected too', async () => {
    const base = await seedSession();
    await op(base, 'acquire', { epoch: 4 });
    await op(base, 'release', { epoch: 6, now: at(5) });

    // acquire(epoch 4) was minted BEFORE the release — out of order, not applied.
    const stale = await op(base, 'acquire', { epoch: 4, now: at(6) });
    expect(stale).toMatchObject({ ok: true, applied: false, state: { held: false } });

    // A genuinely new toggle-on (higher epoch) re-acquires fine.
    const fresh = await op(base, 'acquire', { epoch: 7, now: at(7) });
    expect(fresh).toMatchObject({ ok: true, applied: true, state: { held: true } });
  });

  it('concurrent same-client acquires: the higher epoch wins regardless of arrival order', async () => {
    const base = await seedSession();
    // Two racing first acquires (e.g. a double toggle) — whichever lands second,
    // the stored epoch must end at 2 and the hold must be live.
    await Promise.all([
      op(base, 'acquire', { epoch: 2 }),
      op(base, 'acquire', { epoch: 1, now: at(1) }),
    ]);
    // A stale release proves the stored row: it must be rejected against epoch 2
    // (were the row regressed to 1, this release would wrongly apply).
    const stale = await op(base, 'release', { epoch: 1, now: at(2) });
    expect(stale).toMatchObject({
      ok: true,
      applied: false,
      state: { held: true, lease: { epoch: 2, released: false } },
    });
  });

  it('a duplicate in-flight acquire retry cannot resurrect an equal-epoch release', async () => {
    const base = await seedSession();
    // acquire(10) lands, is retried in flight, and the user toggles loop OFF —
    // release(10) is contract-valid (epoch ≥ stored). The delayed duplicate
    // acquire(10) then arrives: it must NOT clear the release.
    await op(base, 'acquire', { epoch: 10 });
    await op(base, 'release', { epoch: 10, now: at(1) });

    const duplicate = await op(base, 'acquire', { epoch: 10, now: at(2) });
    expect(duplicate).toMatchObject({
      ok: true,
      applied: false,
      state: { held: false, lease: { epoch: 10, released: true } },
    });

    // A genuinely new toggle-on re-acquires with a strictly newer epoch.
    const fresh = await op(base, 'acquire', { epoch: 11, now: at(3) });
    expect(fresh).toMatchObject({ ok: true, applied: true, state: { held: true } });
  });

  it('a duplicate in-flight acquire retry cannot resurrect an EXPIRED lease either', async () => {
    const base = await seedSession();
    // acquire(10) is acknowledged, the tab crashes, and the lease expires —
    // expiry IS the crash/network-loss lapse mechanism. A delayed duplicate
    // acquire(10) must not refresh the TTL and report the session held again.
    await op(base, 'acquire', { epoch: 10 }); // TTL 60s from t0
    const duplicate = await op(base, 'acquire', { epoch: 10, now: at(61) });
    expect(duplicate).toMatchObject({ ok: true, applied: false, state: { held: false } });

    // A restarted tab re-acquires with a strictly newer epoch.
    const fresh = await op(base, 'acquire', { epoch: 11, now: at(62) });
    expect(fresh).toMatchObject({ ok: true, applied: true, state: { held: true } });
  });

  it("a foreign client's release cannot cancel a live hold it doesn't own", async () => {
    const base = await seedSession();
    await op(base, 'acquire', { clientId: 'tab-a', epoch: 1 });

    // Tab B releases with no lease of its own: it gets its OWN released
    // tombstone (reordering safety for its own delayed acquire) — and tab A's
    // hold is untouched; the session stays held.
    const foreign = await op(base, 'release', { clientId: 'tab-b', epoch: 999, now: at(1) });
    expect(foreign).toMatchObject({
      ok: true,
      applied: true,
      state: { held: true, lease: { epoch: 999, released: true } },
    });
    expect(await hasLiveLoopLease(ctx.db, { sessionId: base.sessionId, now: at(2) })).toBe(true);
  });

  it('two tabs hold independently; the session stays held until BOTH lapse', async () => {
    const base = await seedSession();
    await op(base, 'acquire', { clientId: 'tab-a', epoch: 100 });
    // Tab B's epochs are its own sequence — incomparable with tab A's.
    const b = await op(base, 'acquire', { clientId: 'tab-b', epoch: 1, now: at(1) });
    expect(b).toMatchObject({ ok: true, applied: true, state: { held: true } });

    // B releasing its OWN hold does not cancel A's.
    const bRelease = await op(base, 'release', { clientId: 'tab-b', epoch: 2, now: at(2) });
    expect(bRelease).toMatchObject({ ok: true, applied: true, state: { held: true } });

    // A releasing its own hold ends the session-level hold.
    const aRelease = await op(base, 'release', { clientId: 'tab-a', epoch: 101, now: at(3) });
    expect(aRelease).toMatchObject({ ok: true, applied: true, state: { held: false } });
  });

  it('expiry lapses the hold (lock-screen throttling / network loss / crash)', async () => {
    const base = await seedSession();
    await op(base, 'acquire', { epoch: 1 }); // TTL 60s from t0

    expect(await hasLiveLoopLease(ctx.db, { sessionId: base.sessionId, now: at(59) })).toBe(true);
    expect(await hasLiveLoopLease(ctx.db, { sessionId: base.sessionId, now: at(61) })).toBe(false);

    // A renew after expiry does NOT restart the hold — only a fresh acquire does.
    const lateRenew = await op(base, 'renew', { epoch: 2, now: at(61) });
    expect(lateRenew).toMatchObject({ ok: true, applied: false, state: { held: false } });
    const reacquire = await op(base, 'acquire', { epoch: 3, now: at(62) });
    expect(reacquire).toMatchObject({ ok: true, applied: true, state: { held: true } });
  });

  it('is owner-scoped: an unowned session answers not_found (IDOR posture)', async () => {
    const { sessionId } = await seedSession();
    const stranger = await createUser(ctx.db);
    const result = await applyLoopLease(ctx.db, {
      ownerUserId: stranger,
      sessionId,
      clientId: 'tab-x',
      epoch: 1,
      action: 'acquire',
      now: t0,
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it("renew never creates a hold that doesn't exist", async () => {
    const base = await seedSession();
    const renew = await op(base, 'renew', { epoch: 1 });
    expect(renew).toMatchObject({ ok: true, applied: false, state: { held: false, lease: null } });
    expect(await hasLiveLoopLease(ctx.db, { sessionId: base.sessionId, now: t0 })).toBe(false);
  });
});
