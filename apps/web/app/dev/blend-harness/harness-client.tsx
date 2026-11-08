'use client';

// Client shell for the DSP harness page: exposes the render/measure functions on
// `window` for the Playwright harness spec and marks readiness via a test id.

import { useEffect, useState } from 'react';
import { renderBufferEdge } from './buffer-edge';
import { decodeAnchorSeconds, renderEdge, renderLoopSeam } from './harness';
import { runListeningScenario } from './listening-scenario';
import { renderSectionLoop } from './section-loop';

declare global {
  interface Window {
    __liedmotifBlendHarness?: {
      renderEdge: typeof renderEdge;
      renderBufferEdge: typeof renderBufferEdge;
      renderLoopSeam: typeof renderLoopSeam;
      renderSectionLoop: typeof renderSectionLoop;
      decodeAnchorSeconds: typeof decodeAnchorSeconds;
      runListeningScenario: typeof runListeningScenario;
    };
  }
}

export function BlendHarnessClient() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    window.__liedmotifBlendHarness = {
      renderEdge,
      renderBufferEdge,
      renderLoopSeam,
      renderSectionLoop,
      decodeAnchorSeconds,
      runListeningScenario,
    };
    setReady(true);
    return () => {
      delete window.__liedmotifBlendHarness;
    };
  }, []);
  return (
    <main className="p-6 font-mono text-sm">
      <h1>Blend DSP harness</h1>
      <p data-testid="harness-ready">{ready ? 'ready' : 'loading'}</p>
    </main>
  );
}
