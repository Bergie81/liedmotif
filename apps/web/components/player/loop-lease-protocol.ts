// The repeat-one lease protocol for ONE tab —
// plain and framework-free so its reordering/failure semantics carry unit
// coverage in the node test environment; the `useLoopLease` hook is a thin
// React wrapper.
//
// Protocol behavior:
// - Epochs are minted monotonically (`max(now, last + 1)`) so the server's
//   per-client reordering rules hold even when the wall clock stalls.
// - Responses apply LATEST-WINS: a slow response never overwrites the
//   acknowledged state of a newer operation.
// - `renew()` piggybacks on the report cadence; a renew that answers
//   `applied: false` (the lease lapsed, or a first acquire never landed)
//   falls back to a fresh `acquire` while the hold is still wanted — a
//   reconnected looping tab re-establishes its hold by itself. A request
//   hung longer than the stale window stops blocking the cadence (its late
//   response is already sequenced out by latest-wins).
// - The hold is displayed only as long as one lease TTL from the LAST ack
//   that reported it: when confirmed renewals stop arriving
//   (network gone, tab paused/throttled past the TTL), `held` flips false —
//   the UI must never imply a server hold that may already have lapsed. The
//   window is measured from the ack's ARRIVAL on the client clock, never by
//   parsing the server's `expiresAt` (a skewed phone clock would extend a
//   stale "Looping" claim arbitrarily). A later confirmed renewal or
//   re-acquire flips it back. A hold only another tab has (reported by a
//   release ack) gets the same one-TTL window, since this tab no longer
//   renews and nothing re-confirms it.
// - `release()` reports un-held immediately (this tab no longer WANTS the
//   hold; a lost release lapses by TTL — the documented behavior) and the
//   ack still corrects to the session-level truth (another tab may hold).
// - An acquire whose ack never confirms the hold surfaces `onHoldFailed`
//   so the UI can say so instead of implying a hold that does not exist.

import { LOOP_LEASE_TTL_SECONDS, type LoopLeaseAction } from '@liedmotif/shared';

/** A request older than this is ABORTED and no longer blocks the cadence. */
export const LEASE_REQUEST_STALE_MS = 15_000;

/** The acknowledged slice of the loop-lease response the protocol consumes. */
export type LoopLeaseSendResult =
  | {
      ok: true;
      data: {
        applied: boolean;
        held: boolean;
        /** The caller's OWN lease row. */
        lease: { released: boolean } | null;
      };
    }
  | { ok: false };

export type LoopLeaseSend = (req: {
  epoch: number;
  action: LoopLeaseAction;
  /** Aborts the request at the stale deadline (a hung proxy must not
   *  accumulate live connections behind the 15 s cadence recovery). */
  signal?: AbortSignal;
}) => Promise<LoopLeaseSendResult>;

export class LoopLeaseProtocol {
  private epoch = 0;
  /** Latest-wins sequencing across operations. */
  private opSeq = 0;
  private inFlight = false;
  private inFlightAt = 0;
  /** Whether this tab currently WANTS the hold (acquire..release window). */
  private wantHold = false;
  private disposed = false;
  /** Flips `held` false when the acknowledged lease expiry passes unrenewed. */
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: LoopLeaseSend,
    /** The acknowledged session-level hold (any live lease, any client). */
    private readonly onHeldChange: (held: boolean) => void,
    /** The acquire ack did not confirm the hold (network/server failure). */
    private readonly onHoldFailed?: () => void,
  ) {}

  /** Toggle-on: acquire (or refresh) this tab's lease. */
  acquire(): void {
    this.wantHold = true;
    this.dispatch('acquire', (ack) => {
      if (this.wantHold && (ack == null || !ack.held)) this.onHoldFailed?.();
    });
  }

  /** Toggle-off / loop exit: release this tab's lease. */
  release(): void {
    this.wantHold = false;
    this.clearExpiryTimer();
    // Honest immediately: this tab no longer wants the hold. The ack (or the
    // TTL lapse, if the release is lost) makes the server agree — and it may
    // answer held=true when ANOTHER tab still holds its own lease.
    this.onHeldChange(false);
    this.dispatch('release');
  }

  /** Report-cadence tick: renew a live lease, re-acquire a lapsed one. */
  renew(): void {
    if (!this.wantHold) return;
    // One lease operation at a time — but a request hung past the stale
    // window must not suppress the cadence forever (latest-wins already
    // sequences its eventual response out).
    if (this.inFlight && Date.now() - this.inFlightAt < LEASE_REQUEST_STALE_MS) return;
    this.dispatch('renew', (ack) => {
      if (ack?.applied === false && this.wantHold) this.dispatch('acquire');
    });
  }

  /** Best-effort release on teardown; further responses are ignored. */
  dispose(): void {
    const releasePending = this.wantHold;
    this.wantHold = false;
    this.disposed = true;
    this.clearExpiryTimer();
    if (releasePending) {
      void this.send({ epoch: this.nextEpoch(), action: 'release' });
    }
  }

  private nextEpoch(): number {
    this.epoch = Math.max(Date.now(), this.epoch + 1);
    return this.epoch;
  }

  private dispatch(
    action: LoopLeaseAction,
    onAck?: (ack: { applied: boolean; held: boolean } | null) => void,
  ): void {
    const seq = ++this.opSeq;
    this.inFlight = true;
    this.inFlightAt = Date.now();
    // Really terminate a hung request at the stale deadline — the cadence
    // recovery alone would keep piling live connections behind a dead proxy.
    const abort = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const abortTimer = abort ? setTimeout(() => abort.abort(), LEASE_REQUEST_STALE_MS) : null;
    void this.send({
      epoch: this.nextEpoch(),
      action,
      ...(abort ? { signal: abort.signal } : {}),
    }).then((res) => {
      if (abortTimer != null) clearTimeout(abortTimer);
      if (seq === this.opSeq) this.inFlight = false;
      if (this.disposed || seq !== this.opSeq) return;
      if (res.ok) {
        this.onHeldChange(res.data.held);
        this.armExpiryTimer(res.data.held);
      }
      onAck?.(res.ok ? res.data : null);
    });
  }

  /** Bound the DISPLAYED hold to one lease TTL from THIS ack's arrival: if no
   * later ack confirms a live lease before then, report un-held (the server
   * side has lapsed or may have — the UI shows the pending state until an ack
   * confirms). Measured entirely on the client clock — parsing the server's
   * `expiresAt` would let a skewed device clock extend a stale claim. */
  private armExpiryTimer(held: boolean): void {
    this.clearExpiryTimer();
    if (!held) return;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.onHeldChange(false);
    }, LOOP_LEASE_TTL_SECONDS * 1000);
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer != null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }
}
