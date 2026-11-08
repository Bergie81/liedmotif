// Window globals exposed by the development-only browser harnesses, typed from
// the real modules that they exercise.

import type { renderBufferEdge } from '../../app/dev/blend-harness/buffer-edge';
import type {
  decodeAnchorSeconds,
  renderEdge,
  renderLoopSeam,
} from '../../app/dev/blend-harness/harness';
import type { runListeningScenario } from '../../app/dev/blend-harness/listening-scenario';
import type { renderSectionLoop } from '../../app/dev/blend-harness/section-loop';
import type { OfflineStore } from '../../lib/offline/offline-store';

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
    __liedmotifOfflineStoreHarness?: {
      openStore: () => Promise<OfflineStore>;
      readyOfflineLibrary: () => Promise<void>;
      openDeviceStore: () => Promise<void>;
      storedTrackAudio: (trackId: string) => Blob | null;
    };
  }
}

export {};
