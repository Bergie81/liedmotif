// The rules a Start leans on: one Start at a time until its request settles
// (a second tap — even from a fresh Home visit — never fires a second paid
// start), a settled Start engages its session exactly once, and a cancelled
// Start frees the slot, aborts its request, and never takes over the player.
// A refusal that settles before /player mounts waits for it, shown once.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@liedmotif/shared';
import {
  beginPendingStart,
  cancelPendingStart,
  currentPendingStart,
  takeUnshownStartRefusal,
  type PendingStart,
} from './session-handoff';

type StartResult = Awaited<PendingStart['result']>;

const session = { id: 'session-1' } as SessionSummary;
const started: StartResult = { ok: true, data: { session, supersededSessionId: null } };

/** A start request the test settles by hand. */
function controlledRequest() {
  let settle!: (result: StartResult) => void;
  let signal!: AbortSignal;
  const create = vi.fn((s: AbortSignal) => {
    signal = s;
    return new Promise<StartResult>((resolve) => {
      settle = resolve;
    });
  });
  return { create, settle: (r: StartResult) => settle(r), signal: () => signal };
}

describe('session handoff', () => {
  beforeEach(() => {
    cancelPendingStart();
  });

  it('refuses a second Start until the first request settles', async () => {
    const first = controlledRequest();
    const second = controlledRequest();

    expect(beginPendingStart(first.create, vi.fn())).toBe(true);
    expect(beginPendingStart(second.create, vi.fn())).toBe(false);
    expect(second.create).not.toHaveBeenCalled();
    expect(currentPendingStart()).not.toBeNull();

    first.settle(started);
    await currentPendingStart()?.result;
    await Promise.resolve();

    expect(currentPendingStart()).toBeNull();
    expect(beginPendingStart(second.create, vi.fn())).toBe(true);
  });

  it('engages the started session once its request succeeds', async () => {
    const request = controlledRequest();
    const onStarted = vi.fn();
    beginPendingStart(request.create, onStarted);

    const pending = currentPendingStart()!;
    request.settle(started);
    await pending.result;
    await Promise.resolve();

    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(onStarted).toHaveBeenCalledWith(session);
  });

  it('does not engage a Start that failed', async () => {
    const request = controlledRequest();
    const onStarted = vi.fn();
    beginPendingStart(request.create, onStarted);

    const pending = currentPendingStart()!;
    request.settle({
      ok: false,
      error: { code: 'session_headroom_blocked', message: 'No headroom.', retryable: false },
    });
    await pending.result;
    await Promise.resolve();

    expect(onStarted).not.toHaveBeenCalled();
  });

  it('keeps a refusal that settled before any player page showed it, once', async () => {
    const request = controlledRequest();
    beginPendingStart(request.create, vi.fn());
    const pending = currentPendingStart()!;
    const refusal: StartResult = {
      ok: false,
      error: { code: 'session_headroom_blocked', message: 'No headroom.', retryable: false },
    };

    request.settle(refusal);
    await pending.result;
    await Promise.resolve();

    expect(takeUnshownStartRefusal()).toEqual(refusal);
    expect(takeUnshownStartRefusal()).toBeNull();
  });

  it('a cancelled Start aborts its request, frees the slot, and never engages', async () => {
    const request = controlledRequest();
    const onStarted = vi.fn();
    beginPendingStart(request.create, onStarted);
    const pending = currentPendingStart()!;

    cancelPendingStart();

    expect(request.signal().aborted).toBe(true);
    expect(pending.signal.aborted).toBe(true);
    expect(currentPendingStart()).toBeNull();

    // The server answered before the abort reached it: still not engaged.
    request.settle(started);
    await pending.result;
    await Promise.resolve();
    expect(onStarted).not.toHaveBeenCalled();
  });
});
