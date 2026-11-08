import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlayerEngine } from './audio-engine';

// The hard-cut rate invariant (round-12 regression): a cancel-settle
// (`hardCut(active)`) must PRESERVE the surviving deck's playback rate — it
// may carry a legitimate nudge from its own aligned edge, and a queue
// replacement or pause must not change the audible track's tempo mid-play.
// Only the ABANDONED deck resets. Plus the buffer-transport plumbing:
// the per-deck media gate (element muted while a buffer plays, click-safely)
// and AudioContext interruption recovery. Runs the REAL PlayerEngine against a
// fake AudioContext (node has none).

interface ParamCall {
  method: string;
  args: unknown[];
}

function fakeParam(): AudioParam & { calls: ParamCall[] } {
  const calls: ParamCall[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return param;
    };
  const param = {
    value: 1,
    calls,
    setValueAtTime: record('setValueAtTime'),
    setTargetAtTime: record('setTargetAtTime'),
    setValueCurveAtTime: record('setValueCurveAtTime'),
    linearRampToValueAtTime: record('linearRampToValueAtTime'),
    cancelScheduledValues: record('cancelScheduledValues'),
    cancelAndHoldAtTime: record('cancelAndHoldAtTime'),
  };
  return param as unknown as AudioParam & { calls: ParamCall[] };
}

interface FakeNode {
  gain: AudioParam & { calls: ParamCall[] };
  frequency: AudioParam;
  type: string;
  connectedTo: unknown[];
  connect: (dest: unknown) => unknown;
  disconnect: () => void;
}

function fakeNode(): AudioNode & FakeNode {
  const node = {
    gain: fakeParam(),
    frequency: fakeParam(),
    threshold: fakeParam(),
    knee: fakeParam(),
    ratio: fakeParam(),
    attack: fakeParam(),
    release: fakeParam(),
    type: '',
    connectedTo: [] as unknown[],
    connect(dest: unknown) {
      node.connectedTo.push(dest);
      return dest;
    },
    disconnect: () => undefined,
  };
  return node as unknown as AudioNode & FakeNode;
}

class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  constructor() {
    FakeAudioContext.last = this;
  }
  currentTime = 0;
  sampleRate = 48_000;
  state = 'running';
  destination = fakeNode();
  baseLatency = 0.005;
  outputLatency = 0.02;
  sources: Array<AudioNode & FakeNode> = [];
  resumeCalls = 0;
  listeners = new Map<string, Array<() => void>>();
  /** Created gain nodes in construction order (the master bus gain is first). */
  gains: Array<AudioNode & FakeNode> = [];
  createGain = () => {
    const node = fakeNode();
    this.gains.push(node);
    return node;
  };
  createBiquadFilter = fakeNode;
  createDynamicsCompressor = fakeNode;
  createMediaElementSource = () => {
    const node = fakeNode();
    this.sources.push(node);
    return node;
  };
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== listener),
    );
  }
  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  resume() {
    this.resumeCalls += 1;
    this.state = 'running';
    return Promise.resolve();
  }
  closeCalls = 0;
  close() {
    this.closeCalls += 1;
    return Promise.resolve();
  }
}

/** A context that starts in a non-`running` state (never unlocked, or interrupted). */
function audioContextStartingIn(initialState: string) {
  return class extends FakeAudioContext {
    override state = initialState;
  };
}

function fakeEl(): HTMLAudioElement & { playbackRate: number } {
  return { playbackRate: 1, preservesPitch: true } as unknown as HTMLAudioElement & {
    playbackRate: number;
  };
}

describe('PlayerEngine.hardCut rate invariant', () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { AudioContext: FakeAudioContext };
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('preserves the SURVIVING deck’s rate nudge and resets only the abandoned deck', () => {
    const engine = new PlayerEngine();
    const elA = fakeEl();
    const elB = fakeEl();
    engine.attach(elA, elB);
    expect(engine.isActive).toBe(true);

    // Deck A carries a legitimate nudge from its own aligned edge; deck B was
    // a prepared incoming that also got nudged before its edge was cancelled.
    engine.setPlaybackRate('a', 1.06);
    engine.setPlaybackRate('b', 1.03);

    // The cancel-settle: A survives, B is abandoned.
    engine.hardCut('a', 0);
    expect(elA.playbackRate).toBeCloseTo(1.06);
    expect(elB.playbackRate).toBe(1);
  });
});

describe('PlayerEngine.setMasterGain (session handoff)', () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { AudioContext: FakeAudioContext };
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    FakeAudioContext.last = null;
  });

  it('steps the master bus gain click-safely and reports the graph applied it', () => {
    const engine = new PlayerEngine();
    engine.attach(fakeEl(), fakeEl());
    const ctx = FakeAudioContext.last!;
    expect(engine.setMasterGain(0.25)).toBe(true);
    // The master bus gain is the first gain the graph constructs.
    const master = ctx.gains[0]!;
    expect(
      master.gain.calls.some((c) => c.method === 'setTargetAtTime' && c.args[0] === 0.25),
    ).toBe(true);
  });

  it('reports false without a graph so the caller falls back to element volume', () => {
    expect(new PlayerEngine().setMasterGain(0.5)).toBe(false);
  });
});

describe('PlayerEngine buffer-transport plumbing', () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { AudioContext: FakeAudioContext };
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    FakeAudioContext.last = null;
  });

  function attached() {
    const engine = new PlayerEngine();
    engine.attach(fakeEl(), fakeEl());
    return { engine, ctx: FakeAudioContext.last! };
  }

  it('routes each element through a media gate into its chain, and mutes it CLICK-SAFELY', () => {
    const { engine, ctx } = attached();
    // Topology: element source → media gate → chain input.
    const gateA = ctx.sources[0]!.connectedTo[0] as ReturnType<typeof fakeNode>;
    expect(gateA.connectedTo[0]).toBe(engine.deckInput('a'));

    engine.setDeckMediaAudible('a', false);
    // Click-safe step toward 0 — never a direct value jump.
    const last = gateA.gain.calls.at(-1)!;
    expect(last.method).toBe('setTargetAtTime');
    expect(last.args[0]).toBe(0);

    engine.setDeckMediaAudible('a', true);
    expect(gateA.gain.calls.at(-1)!.args[0]).toBe(1);
  });

  it('exposes the context and per-deck buffer input only while a graph exists', () => {
    const { engine, ctx } = attached();
    expect(engine.context()).toBe(ctx as unknown as AudioContext);
    expect(engine.deckInput('b')).not.toBeNull();
    engine.dispose();
    expect(engine.context()).toBeNull();
    expect(engine.deckInput('b')).toBeNull();
  });

  it('prime() creates and resumes the context BEFORE any deck exists (the start-session gesture)', () => {
    const engine = new PlayerEngine();
    engine.prime();
    // The context exists and was unlocked inside the gesture…
    const primed = FakeAudioContext.last!;
    expect(primed).not.toBeNull();
    expect(primed.resumeCalls).toBe(1);
    // …but no graph exists yet (no decks to bind).
    expect(engine.isActive).toBe(false);
  });

  it('attach() builds the graph ON the primed context instead of constructing a second one', () => {
    const engine = new PlayerEngine();
    engine.prime();
    const primed = FakeAudioContext.last!;

    engine.attach(fakeEl(), fakeEl());
    expect(engine.isActive).toBe(true);
    expect(FakeAudioContext.last).toBe(primed);
    expect(engine.context()).toBe(primed as unknown as AudioContext);
  });

  it.each(['suspended', 'interrupted'])(
    'resumes an attached %s context before building the graph',
    async (initialState) => {
      (globalThis as { window?: unknown }).window = {
        AudioContext: audioContextStartingIn(initialState),
      };
      const engine = new PlayerEngine();

      engine.attach(fakeEl(), fakeEl());
      engine.hardCut('a', 0);
      engine.hardCut('b', 0);
      expect(engine.isActive).toBe(false);

      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(engine.isActive).toBe(true);
      const context = FakeAudioContext.last!;
      expect(engine.context()).toBe(context as unknown as AudioContext);
      expect(
        context.gains[6]?.gain.calls.some(
          (call) => call.method === 'setTargetAtTime' && call.args[0] === 1,
        ),
      ).toBe(true);
    },
  );

  it('dispose() releases a primed context that never attached', () => {
    const engine = new PlayerEngine();
    engine.prime();
    const primed = FakeAudioContext.last!;
    engine.dispose();
    expect(primed.closeCalls).toBe(1);
  });

  it('interruption recovery resumes a suspended context on statechange while playback is wanted', () => {
    const { engine, ctx } = attached();
    let wantPlay = true;
    const unbind = engine.bindInterruptionRecovery(() => wantPlay);

    ctx.state = 'suspended';
    ctx.emit('statechange');
    expect(ctx.resumeCalls).toBe(1);

    // Not wanted → no resume attempt.
    wantPlay = false;
    ctx.state = 'suspended';
    ctx.emit('statechange');
    expect(ctx.resumeCalls).toBe(1);

    // Unbound → no resume attempt.
    wantPlay = true;
    unbind();
    ctx.emit('statechange');
    expect(ctx.resumeCalls).toBe(1);
  });

  it('interruption recovery bound while the graph waits for a suspended context still resumes it later', async () => {
    (globalThis as { window?: unknown }).window = {
      AudioContext: audioContextStartingIn('suspended'),
    };
    const engine = new PlayerEngine();
    engine.attach(fakeEl(), fakeEl());
    engine.bindInterruptionRecovery(() => true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(engine.isActive).toBe(true);
    const ctx = FakeAudioContext.last!;
    const resumesAfterAttach = ctx.resumeCalls;

    ctx.state = 'suspended';
    ctx.emit('statechange');
    expect(ctx.resumeCalls).toBe(resumesAfterAttach + 1);
  });
});
