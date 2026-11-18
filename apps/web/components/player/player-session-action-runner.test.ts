import { describe, expect, it, vi } from 'vitest';
import { closeCreationRefusal, shownCreationRefusal } from '@/components/create/creation-refusal';
import {
  runPlayerSessionAction,
  type PlayerSessionActionGate,
} from './player-session-action-runner';

function gate(): PlayerSessionActionGate {
  return { active: null };
}

describe('player Session action runner', () => {
  it('publishes busy state and delivers a successful result once', async () => {
    const busy = vi.fn();
    const succeed = vi.fn();
    const fail = vi.fn();

    const result = await runPlayerSessionAction({
      gate: gate(),
      action: 'stop',
      failureLabel: 'Stop failed',
      request: async () => ({ ok: true as const, data: { stopped: true } }),
      onBusyChange: busy,
      onFailure: fail,
      onSuccess: succeed,
    });

    expect(result).toBe(true);
    expect(busy.mock.calls).toEqual([['stop'], [null]]);
    expect(fail).toHaveBeenCalledWith(null);
    expect(succeed).toHaveBeenCalledWith({ stopped: true });
  });

  it('surfaces a typed failure and does not call success', async () => {
    const fail = vi.fn();
    const succeed = vi.fn();

    const result = await runPlayerSessionAction({
      gate: gate(),
      action: 'change-vibe',
      failureLabel: 'Change Vibe failed',
      request: async () => ({ ok: false as const, error: { message: 'Text LLM required.' } }),
      onBusyChange: vi.fn(),
      onFailure: fail,
      onSuccess: succeed,
    });

    expect(result).toBe(false);
    expect(fail).toHaveBeenLastCalledWith({
      action: 'change-vibe',
      message: 'Change Vibe failed: Text LLM required.',
    });
    expect(succeed).not.toHaveBeenCalled();
  });

  it('rejects a duplicate action while the first request is pending', async () => {
    let resolveRequest!: (value: { ok: true; data: string }) => void;
    const request = vi.fn(
      () =>
        new Promise<{ ok: true; data: string }>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const sharedGate = gate();
    const input = {
      gate: sharedGate,
      action: 'more-like-this' as const,
      failureLabel: 'More Like This failed',
      request,
      onBusyChange: vi.fn(),
      onFailure: vi.fn(),
      onSuccess: vi.fn(),
    };

    const first = runPlayerSessionAction(input);
    const duplicate = await runPlayerSessionAction(input);
    resolveRequest({ ok: true, data: 'started' });

    expect(duplicate).toBe(false);
    expect(await first).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  // A creating action refused for headroom shows the blocked dialog with its
  // ways out; an action that creates nothing keeps its error.
  it('opens the blocked dialog, not an error, when a creating action has no headroom', async () => {
    const fail = vi.fn();
    const error = { code: 'session_headroom_blocked' as const, message: 'Needs 5 Tracks.' };

    const result = await runPlayerSessionAction({
      gate: gate(),
      action: 'more-like-this',
      failureLabel: 'More Like This failed',
      createsSession: true,
      request: async () => ({ ok: false as const, error }),
      onBusyChange: vi.fn(),
      onFailure: fail,
      onSuccess: vi.fn(),
    });

    expect(result).toBe(false);
    expect(shownCreationRefusal()).toEqual({ kind: 'headroom', message: 'Needs 5 Tracks.' });
    expect(fail).not.toHaveBeenCalledWith(expect.objectContaining({ message: expect.anything() }));
    closeCreationRefusal();

    await runPlayerSessionAction({
      gate: gate(),
      action: 'change-vibe',
      failureLabel: 'Change Vibe failed',
      request: async () => ({ ok: false as const, error }),
      onBusyChange: vi.fn(),
      onFailure: fail,
      onSuccess: vi.fn(),
    });
    expect(shownCreationRefusal()).toBeNull();
    expect(fail).toHaveBeenLastCalledWith({
      action: 'change-vibe',
      message: 'Change Vibe failed: Needs 5 Tracks.',
    });
  });
});
