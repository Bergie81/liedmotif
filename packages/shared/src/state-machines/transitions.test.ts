import { describe, expect, it } from 'vitest';
import {
  LIVE_QUEUE_ITEM_STATES,
  MACHINES,
  MACHINE_STATES,
  QUEUE_ITEM_TRANSITIONS,
  SESSION_FIELD_WRITERS,
  STATE_MACHINE_WRITERS,
  SUPERSEDED_SESSION_STATUS,
  assertAtMostOneActiveSession,
  assertChangeVibePreservesSession,
  assertNoProviderResubmitAfterTask,
  assertResumeReactivates,
  assertTransition,
  canTransition,
  isTerminalState,
  nextStates,
  resolveActivePlaybackClient,
  type Machine,
} from './transitions';
import {
  PROVIDER_NORMALIZED_STATUSES,
  QUEUE_ITEM_STATES,
  type ProviderNormalizedStatus,
} from './literals';

describe('canTransition / assertTransition — generic behavior', () => {
  it('rejects a self-transition (from === to is a no-op, not a move)', () => {
    expect(canTransition('activitySessionStatus', 'active', 'active')).toBe(false);
    expect(canTransition('trackStatus', 'ready', 'ready')).toBe(false);
  });

  it('assertTransition throws a descriptive error listing the allowed targets', () => {
    expect(() => assertTransition('trackStatus', 'deleted', 'ready')).toThrow(
      /Illegal trackStatus transition: "deleted" → "ready".*terminal/,
    );
    expect(() => assertTransition('activitySessionStatus', 'active', 'stopped')).not.toThrow();
  });

  it('assertTransition is silent for a legal move', () => {
    expect(() => assertTransition('queueItemState', 'queued', 'playing')).not.toThrow();
  });
});

describe('activitySessionStatus machine (two-state: active ↔ stopped)', () => {
  it('is exactly active ↔ stopped — every exit lands on stopped, Resume re-activates', () => {
    // User Stop, supersede, idle auto-stop, and bounded-complete all land on
    // `stopped` (the reason is recorded in `endReason`, not a distinct state).
    expect(nextStates('activitySessionStatus', 'active')).toEqual(['stopped']);
    // Resume re-activates a stopped session (same identity).
    expect(nextStates('activitySessionStatus', 'stopped')).toEqual(['active']);
    expect(canTransition('activitySessionStatus', 'active', 'stopped')).toBe(true);
    expect(canTransition('activitySessionStatus', 'stopped', 'active')).toBe(true);
  });
});

describe('queueItemState machine', () => {
  it('allows the documented buffer + playback moves', () => {
    expect(canTransition('queueItemState', 'planned', 'generating')).toBe(true);
    expect(canTransition('queueItemState', 'planned', 'queued')).toBe(true);
    expect(canTransition('queueItemState', 'generating', 'queued')).toBe(true);
    expect(canTransition('queueItemState', 'queued', 'playing')).toBe(true);
    // An `ended` report can land without its `started` (lost in transit) — the
    // start is implied, so the item may complete straight from `queued`.
    expect(canTransition('queueItemState', 'queued', 'played')).toBe(true);
    expect(canTransition('queueItemState', 'playing', 'played')).toBe(true);
    expect(canTransition('queueItemState', 'playing', 'skipped')).toBe(true);
    expect(canTransition('queueItemState', 'playing', 'rejected')).toBe(true);
    expect(canTransition('queueItemState', 'playing', 'failed')).toBe(true);
  });

  it('allows explicit owner deletion to terminalize every live queue slot', () => {
    for (const state of LIVE_QUEUE_ITEM_STATES) {
      expect(canTransition('queueItemState', state, 'rejected')).toBe(true);
    }
    expect(STATE_MACHINE_WRITERS.queueItemState).toContain('api-routes:owner-delete');
  });

  it('rejects illegal moves', () => {
    // must pass through queued before playing.
    expect(canTransition('queueItemState', 'planned', 'playing')).toBe(false);
    // played/skipped/rejected/failed are terminal.
    expect(canTransition('queueItemState', 'played', 'playing')).toBe(false);
    expect(canTransition('queueItemState', 'skipped', 'playing')).toBe(false);
    expect(canTransition('queueItemState', 'rejected', 'queued')).toBe(false);
    expect(canTransition('queueItemState', 'generating', 'playing')).toBe(false);
  });

  it('LIVE_QUEUE_ITEM_STATES is exactly the non-terminal states of the map', () => {
    const nonTerminal = QUEUE_ITEM_STATES.filter(
      (state) => QUEUE_ITEM_TRANSITIONS[state].length > 0,
    );
    expect([...LIVE_QUEUE_ITEM_STATES]).toEqual(nonTerminal);
  });
});

describe('providerNormalizedStatus machine (worker-only)', () => {
  it('allows the documented submit→poll progression', () => {
    expect(canTransition('providerNormalizedStatus', 'queued', 'submitted')).toBe(true);
    expect(canTransition('providerNormalizedStatus', 'queued', 'submit_unknown')).toBe(true);
    expect(canTransition('providerNormalizedStatus', 'submitted', 'processing')).toBe(true);
    expect(canTransition('providerNormalizedStatus', 'processing', 'partially_ready')).toBe(true);
    expect(canTransition('providerNormalizedStatus', 'partially_ready', 'ready')).toBe(true);
    // Only the PRE-submit cost block auto-resumes to `queued`.
    expect(canTransition('providerNormalizedStatus', 'blocked_by_liedmotif_limit', 'queued')).toBe(
      true,
    );
    // Recovery re-polls (post-submit) or re-attempts the submit (pre-submit) — never via `queued`.
    expect(canTransition('providerNormalizedStatus', 'provider_rate_limited', 'processing')).toBe(
      true,
    );
    expect(canTransition('providerNormalizedStatus', 'failed_retryable', 'submitted')).toBe(true);
    // A poll after backoff can observe SUCCESS directly (one-hop recovery → ready).
    expect(canTransition('providerNormalizedStatus', 'provider_rate_limited', 'ready')).toBe(true);
    expect(canTransition('providerNormalizedStatus', 'failed_retryable', 'ready')).toBe(true);
    // A sensitive word is rejected during the polling phase (post-submit policy block).
    expect(canTransition('providerNormalizedStatus', 'submitted', 'blocked_by_policy')).toBe(true);
    expect(canTransition('providerNormalizedStatus', 'processing', 'blocked_by_policy')).toBe(true);
    // The poll reports an out-of-credits failure for a job that already holds a taskId.
    expect(
      canTransition('providerNormalizedStatus', 'submitted', 'blocked_by_provider_credits'),
    ).toBe(true);
  });

  it('rejects illegal moves and respects terminal states', () => {
    // submit must precede processing.
    expect(canTransition('providerNormalizedStatus', 'queued', 'processing')).toBe(false);
    expect(canTransition('providerNormalizedStatus', 'queued', 'ready')).toBe(false);
    // submit_unknown is terminal for the automatic machine (no auto-retry).
    expect(canTransition('providerNormalizedStatus', 'submit_unknown', 'submitted')).toBe(false);
    // a policy block needs a new user-edited request, not a retry.
    expect(canTransition('providerNormalizedStatus', 'blocked_by_policy', 'queued')).toBe(false);
    // money-safety: recovery states never return to `queued` (re-submitting a job that
    // may already hold a providerTaskId would be a second paid call).
    expect(canTransition('providerNormalizedStatus', 'provider_rate_limited', 'queued')).toBe(
      false,
    );
    expect(canTransition('providerNormalizedStatus', 'failed_retryable', 'queued')).toBe(false);
    // a content block can't appear once a track already cleared checks (FIRST_SUCCESS).
    expect(canTransition('providerNormalizedStatus', 'partially_ready', 'blocked_by_policy')).toBe(
      false,
    );
    // terminal success/failure.
    expect(canTransition('providerNormalizedStatus', 'ready', 'processing')).toBe(false);
    expect(canTransition('providerNormalizedStatus', 'failed_final', 'queued')).toBe(false);
    // a credits block is lifted by a fresh job, never by re-queueing one that may hold a taskId.
    expect(canTransition('providerNormalizedStatus', 'blocked_by_provider_credits', 'queued')).toBe(
      false,
    );
  });
});

describe('providerNormalizedStatus money-safety (no paid re-submit after a taskId)', () => {
  // The paid provider submit happens on `queued → submitted`. Once a job has been
  // submitted (taskId captured), it must NEVER reach `queued` again or it could be
  // charged twice. These tests prove the property structurally from the map.
  function reachableFrom(start: ProviderNormalizedStatus): Set<string> {
    const seen = new Set<string>([start]);
    const stack: ProviderNormalizedStatus[] = [start];
    while (stack.length > 0) {
      const from = stack.pop() as ProviderNormalizedStatus;
      for (const to of nextStates('providerNormalizedStatus', from)) {
        if (!seen.has(to)) {
          seen.add(to);
          stack.push(to);
        }
      }
    }
    return seen;
  }

  it('no post-submit state can reach `queued`', () => {
    for (const from of [
      'submitted',
      'processing',
      'partially_ready',
      'provider_rate_limited',
      'failed_retryable',
    ] as const) {
      expect(reachableFrom(from).has('queued')).toBe(false);
    }
  });

  it('the only predecessor of `queued` is the pre-submit cost block', () => {
    const predecessors = PROVIDER_NORMALIZED_STATUSES.filter((s) =>
      nextStates('providerNormalizedStatus', s).includes('queued'),
    );
    expect(predecessors).toEqual(['blocked_by_liedmotif_limit']);
  });

  it('assertNoProviderResubmitAfterTask blocks a paid re-call once a taskId exists', () => {
    // `→ submitted` stays legal in the map to serve the PRE-submit retry, so the
    // memoryless map alone can't stop a POST-submit re-call. This guard does.
    expect(() => assertNoProviderResubmitAfterTask(true, 'submitted')).toThrow(/double-charge/);
    expect(() => assertNoProviderResubmitAfterTask(true, 'queued')).toThrow(/double-charge/);
    // No taskId yet → the first paid submit (and pre-submit retry) is allowed.
    expect(() => assertNoProviderResubmitAfterTask(false, 'submitted')).not.toThrow();
    // A job that holds a taskId may still re-poll.
    expect(() => assertNoProviderResubmitAfterTask(true, 'processing')).not.toThrow();
    expect(() => assertNoProviderResubmitAfterTask(true, 'ready')).not.toThrow();
  });
});

describe('trackStatus machine', () => {
  it('allows the documented readiness + rejection ladder', () => {
    expect(canTransition('trackStatus', 'pending', 'streamable')).toBe(true);
    expect(canTransition('trackStatus', 'pending', 'ready')).toBe(true);
    expect(canTransition('trackStatus', 'streamable', 'ready')).toBe(true);
    expect(canTransition('trackStatus', 'ready', 'rejected')).toBe(true);
    expect(canTransition('trackStatus', 'ready', 'deleted')).toBe(true);
    expect(canTransition('trackStatus', 'rejected', 'deleted')).toBe(true);
  });

  it('allows explicit owner deletion from every non-terminal status', () => {
    for (const state of ['pending', 'streamable', 'ready', 'rejected', 'failed'] as const) {
      expect(canTransition('trackStatus', state, 'deleted')).toBe(true);
    }
    expect(STATE_MACHINE_WRITERS.trackStatus).toContain('api-routes:owner-delete');
  });

  it('rejects illegal moves', () => {
    expect(canTransition('trackStatus', 'deleted', 'ready')).toBe(false);
    expect(canTransition('trackStatus', 'ready', 'pending')).toBe(false);
    expect(canTransition('trackStatus', 'rejected', 'ready')).toBe(false);
    // a fully-downloaded local track does not "fail" (playback errors are queue-item failures).
    expect(canTransition('trackStatus', 'ready', 'failed')).toBe(false);
  });
});

describe('structural integrity of every machine', () => {
  it('every state is a key in its map and every target is a valid state', () => {
    for (const machine of MACHINES) {
      const states = MACHINE_STATES[machine] as readonly string[];
      const stateSet = new Set(states);
      for (const from of states) {
        // `from` resolves to a (possibly empty) target list, and no target is unknown.
        const targets = nextStates(machine as Machine, from as never) as readonly string[];
        for (const to of targets) {
          expect(stateSet.has(to)).toBe(true);
          // change-only: no state lists itself as a target.
          expect(to).not.toBe(from);
        }
        // targets are duplicate-free.
        expect(new Set(targets).size).toBe(targets.length);
      }
    }
  });

  it('exposes legal writers for every machine', () => {
    for (const machine of MACHINES) {
      expect(STATE_MACHINE_WRITERS[machine].length).toBeGreaterThan(0);
    }
  });

  it('marks the expected terminal states', () => {
    expect(isTerminalState('trackStatus', 'deleted')).toBe(true);
    expect(isTerminalState('providerNormalizedStatus', 'ready')).toBe(true);
    expect(isTerminalState('providerNormalizedStatus', 'failed_final')).toBe(true);
    expect(isTerminalState('queueItemState', 'played')).toBe(true);
    // The two-state session lifecycle has NO terminal state — a Stopped session is
    // always resumable (stopped → active), and an active one can always stop.
    expect(isTerminalState('activitySessionStatus', 'active')).toBe(false);
    expect(isTerminalState('activitySessionStatus', 'stopped')).toBe(false);
  });
});

describe('cross-machine session invariants', () => {
  it('supersedes a prior active session to "stopped"', () => {
    expect(SUPERSEDED_SESSION_STATUS).toBe('stopped');
    // The supersession move itself is a legal lifecycle transition.
    expect(canTransition('activitySessionStatus', 'active', SUPERSEDED_SESSION_STATUS)).toBe(true);
  });

  it('enforces at most one active session per user', () => {
    expect(() => assertAtMostOneActiveSession(['active', 'stopped', 'stopped'])).not.toThrow();
    expect(() => assertAtMostOneActiveSession(['active', 'active'])).toThrow(/at most one/);
  });

  it('Resume re-activates a Stopped session in place (same id, stopped → active)', () => {
    expect(() =>
      assertResumeReactivates({ id: 's1', status: 'stopped' }, { id: 's1', status: 'active' }),
    ).not.toThrow();
    // Resume restores the SAME session identity — a new id would be More Like This.
    expect(() =>
      assertResumeReactivates({ id: 's1', status: 'stopped' }, { id: 's2', status: 'active' }),
    ).toThrow(/same Session identity/);
    // It must actually move stopped → active (not re-activate an already-active one).
    expect(() =>
      assertResumeReactivates({ id: 's1', status: 'active' }, { id: 's1', status: 'active' }),
    ).toThrow(/"stopped".*"active"/);
  });

  it('records the non-transition session-field writers separately from the transition machines', () => {
    // generationStatus / sessionMode are session FIELDS, not transition graphs,
    // so they are absent from STATE_MACHINE_WRITERS and recorded here.
    expect(STATE_MACHINE_WRITERS).not.toHaveProperty('generationStatus');
    expect(STATE_MACHINE_WRITERS).not.toHaveProperty('sessionMode');
    // generationStatus is controller state → buffer controller only.
    expect(SESSION_FIELD_WRITERS.generationStatus).toContain('buffer-controller');
    expect(SESSION_FIELD_WRITERS.generationStatus).not.toContain('api-routes:user-intent');
    // sessionMode is user intent → API routes only.
    expect(SESSION_FIELD_WRITERS.sessionMode).toContain('api-routes:user-intent');
    expect(SESSION_FIELD_WRITERS.sessionMode).not.toContain('buffer-controller');
    // The writer tokens are canonical — the same spellings the transition machines
    // use — so one grep answers "who may write this column" across both maps.
    expect(STATE_MACHINE_WRITERS.queueItemState).toContain('buffer-controller');
    expect(STATE_MACHINE_WRITERS.activitySessionStatus).toContain('api-routes:user-intent');
  });

  it('keeps Change Vibe in place (same id, status stays active)', () => {
    expect(() =>
      assertChangeVibePreservesSession(
        { id: 's1', status: 'active' },
        { id: 's1', status: 'active' },
      ),
    ).not.toThrow();
    // A new identity would be More Like This, not Change Vibe.
    expect(() =>
      assertChangeVibePreservesSession(
        { id: 's1', status: 'active' },
        { id: 's2', status: 'active' },
      ),
    ).toThrow(/same Session identity/);
    // Change Vibe must not move the lifecycle.
    expect(() =>
      assertChangeVibePreservesSession(
        { id: 's1', status: 'active' },
        { id: 's1', status: 'stopped' },
      ),
    ).toThrow(/status must stay "active"/);
  });

  it('lets the latest reporting client win the active playback client', () => {
    expect(resolveActivePlaybackClient(null, 'phone-A')).toEqual({
      activeClientId: 'phone-A',
      changed: true,
    });
    // A different device taking over is flagged as a control change.
    expect(resolveActivePlaybackClient('phone-A', 'phone-B')).toEqual({
      activeClientId: 'phone-B',
      changed: true,
    });
    // The same device re-reporting keeps control without a change.
    expect(resolveActivePlaybackClient('phone-A', 'phone-A')).toEqual({
      activeClientId: 'phone-A',
      changed: false,
    });
  });
});
