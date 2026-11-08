// Dev-only DSP harness page: the Playwright
// `playback-harness` job drives `window.__liedmotifBlendHarness` here to render
// transitions through the REAL blend graph offline and assert the thresholds
// table. Never available in production builds.

import { notFound } from 'next/navigation';
import { BlendHarnessClient } from './harness-client';

export const dynamic = 'force-dynamic';

export default function BlendHarnessPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <BlendHarnessClient />;
}
