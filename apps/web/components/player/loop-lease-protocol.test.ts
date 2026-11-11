import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEASE_REQUEST_STALE_MS,
  LoopLeaseProtocol,
  type LoopLeaseSendResult,
} from './loop-lease-protocol';

// The one-tab lease protocol: monotonic epochs, latest-wins acks,
// self-healing renewal, and truthful hold reporting — the failure/reordering
// semantics the client must uphold.

interface Sent {
  epoch: number;
  action: string;
  signal: AbortSignal | undefined;
  settle: (res: LoopLeaseSendResult) => void;
}

function harness(onHoldFailed?: () => void) {
  const sent: Sent[] = [];
  const heldChanges: boolean[] = [];
  const protocol = new LoopLeaseProtocol(
    ({ epoch, action, signal }) =>
      new Promise<LoopLeaseSendResult>((resolve) => {
        sent.push({ epoch, action, signal, settle: resolve });
      }),
    (held) => heldChanges.push(held),
    onHoldFailed,
  );
  const ok = (
    applied: boolean,
    held: boolean,
    lease: { released: boolean } | null = null,
  ): LoopLeaseSendResult => ({
    ok: true,
    data: { applied, held, lease },
  });
  return { protocol, sent, heldChanges, ok };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('LoopLeaseProtocol', () => {
  it('acquire acknowledges the held state from the server response', async () => {
    const h = harness();
    h.protocol.acquire();
    expect(h.sent[0]?.action).toBe('acquire');
    h.sent[0]!.settle(h.ok(true, true));
    await flush();
    expect(h.heldChanges).toEqual([true]);
  });

  it('mints strictly increasing epochs across every operation (reordering safety)', async () => {
    const h = harness();
    h.protocol.acquire();
    h.protocol.release();
    h.protocol.acquire();
    const epochs = h.sent.map((s) => s.epoch);
    expect(epochs.length).toBe(3);
    expect(epochs[1]!).toBeGreaterThan(epochs[0]!);
    expect(epochs[2]!).toBeGreaterThan(epochs[1]!);
  });

  it('applies responses LATEST-WINS: a slow acquire ack cannot overwrite a release', async () => {
    const h = harness();
    h.protocol.acquire();
    h.protocol.release(); // optimistic un-held; supersedes the acquire
    expect(h.heldChanges).toEqual([false]);
    // The SLOW acquire ack lands after the release was issued: ignored.
    h.sent[0]!.settle(h.ok(true, true));
    await flush();
    expect(h.heldChanges).toEqual([false]);
    // The release ack still applies (it is the latest operation).
    h.sent[1]!.settle(h.ok(true, false));
    await flush();
    expect(h.heldChanges).toEqual([false, false]);
  });

  it('a release ack reporting held=true (another tab holds) corrects the state', async () => {
    const h = harness();
    h.protocol.release();
    h.sent[0]!.settle(h.ok(true, true));
    await flush();
    expect(h.heldChanges).toEqual([false, true]);
  });

  it('renew extends while wanted, and a lapsed lease self-heals via re-acquire', async () => {
    const h = harness();
    h.protocol.acquire();
    h.sent[0]!.settle(h.ok(true, true));
    await flush();
    h.protocol.renew();
    expect(h.sent[1]?.action).toBe('renew');
    // The lease lapsed server-side (lock-screen throttling): renew does not
    // apply → the protocol re-acquires with a fresh, higher epoch.
    h.sent[1]!.settle(h.ok(false, false));
    await flush();
    expect(h.sent[2]?.action).toBe('acquire');
    expect(h.sent[2]!.epoch).toBeGreaterThan(h.sent[1]!.epoch);
  });

  it('renew is a no-op while un-wanted or while an operation is in flight', () => {
    const h = harness();
    h.protocol.renew(); // never acquired
    expect(h.sent).toHaveLength(0);
    h.protocol.acquire(); // in flight
    h.protocol.renew();
    expect(h.sent).toHaveLength(1);
  });

  it('a failed acquire surfaces onHoldFailed and the cadence self-heals', async () => {
    let failures = 0;
    const h = harness(() => {
      failures += 1;
    });
    h.protocol.acquire();
    h.sent[0]!.settle({ ok: false });
    await flush();
    expect(failures).toBe(1);
    // The next cadence tick renews; the server has no lease → re-acquire.
    h.protocol.renew();
    h.sent[1]!.settle(h.ok(false, false));
    await flush();
    expect(h.sent[2]?.action).toBe('acquire');
  });

  it('a rejected acquire ack (applied but not held) also surfaces onHoldFailed', async () => {
    let failures = 0;
    const h = harness(() => {
      failures += 1;
    });
    h.protocol.acquire();
    h.sent[0]!.settle(h.ok(false, false));
    await flush();
    expect(failures).toBe(1);
  });

  it('dispose releases a wanted hold best-effort and ignores late responses', async () => {
    const h = harness();
    h.protocol.acquire();
    h.protocol.dispose();
    expect(h.sent.map((s) => s.action)).toEqual(['acquire', 'release']);
    h.sent[0]!.settle(h.ok(true, true));
    h.sent[1]!.settle(h.ok(true, false));
    await flush();
    // No held-change callbacks after dispose.
    expect(h.heldChanges).toEqual([]);
  });

  it('dispose without a wanted hold sends nothing', () => {
    const h = harness();
    h.protocol.dispose();
    expect(h.sent).toHaveLength(0);
  });
});

describe('LoopLeaseProtocol — acknowledged-hold window and hung requests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const LIVE = { released: false };

  it('the DISPLAYED hold expires one TTL after the last confirmed ack (network gone / throttled)', async () => {
    const h = harness();
    h.protocol.acquire();
    h.sent[0]!.settle(h.ok(true, true, LIVE));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.heldChanges).toEqual([true]);
    // No renewal lands (every request fails); the hold window passes.
    h.protocol.renew();
    h.sent[1]!.settle({ ok: false });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(h.heldChanges).toEqual([true, false]);
  });

  it('the hold window is measured on the CLIENT clock — server clock skew cannot extend it', async () => {
    // The response deliberately carries no usable expiry: whatever a skewed
    // server (or device) clock would claim, the displayed hold ends one TTL
    // after the ack ARRIVED unless a newer ack confirms.
    const h = harness();
    h.protocol.acquire();
    h.sent[0]!.settle(h.ok(true, true, LIVE));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(h.heldChanges).toEqual([true]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.heldChanges).toEqual([true, false]);
  });

  it('a confirmed renewal re-arms the hold window', async () => {
    const h = harness();
    h.protocol.acquire();
    h.sent[0]!.settle(h.ok(true, true, LIVE));
    await vi.advanceTimersByTimeAsync(30_000);
    h.protocol.renew();
    h.sent[1]!.settle(h.ok(true, true, LIVE));
    // Past the ORIGINAL window but inside the renewed one: still held.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(h.heldChanges).toEqual([true, true]);
    // The renewed window passes without another ack: un-held.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.heldChanges).toEqual([true, true, false]);
  });

  it('release disarms the hold window (no late un-held flip after a clean exit)', async () => {
    const h = harness();
    h.protocol.acquire();
    h.sent[0]!.settle(h.ok(true, true, LIVE));
    await vi.advanceTimersByTimeAsync(0);
    h.protocol.release();
    h.sent[1]!.settle(h.ok(true, false, { released: true }));
    await vi.advanceTimersByTimeAsync(120_000);
    // One optimistic false + one acknowledged false — no third flip from a
    // stale hold-window timer.
    expect(h.heldChanges).toEqual([true, false, false]);
  });

  it("another tab's hold reported by a release ack is displayed for one TTL, not forever", async () => {
    const h = harness();
    h.protocol.acquire();
    h.sent[0]!.settle(h.ok(true, true, LIVE));
    await vi.advanceTimersByTimeAsync(0);
    h.protocol.release();
    h.sent[1]!.settle(h.ok(true, true, { released: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.heldChanges).toEqual([true, false, true]);
    // This tab no longer renews, so nothing re-confirms the other tab's hold.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(h.heldChanges).toEqual([true, false, true, false]);
  });

  it('a HUNG request is ABORTED at the stale window and stops blocking the cadence', async () => {
    const h = harness();
    h.protocol.acquire(); // never settles
    h.protocol.renew();
    expect(h.sent).toHaveLength(1); // blocked while fresh
    expect(h.sent[0]!.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(LEASE_REQUEST_STALE_MS + 1000);
    // The hung request was really terminated (no connection pile-up)…
    expect(h.sent[0]!.signal?.aborted).toBe(true);
    // …and the cadence recovered.
    h.protocol.renew();
    expect(h.sent).toHaveLength(2);
    // The hung acquire finally settles anyway: latest-wins discards it.
    h.sent[0]!.settle(h.ok(true, true, LIVE));
    h.sent[1]!.settle(h.ok(true, true, LIVE));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.heldChanges).toEqual([true]);
  });
});
