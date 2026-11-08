// Dev-only offline-store harness: the Playwright offline-store spec drives
// `window.__liedmotifOfflineStoreHarness` here to exercise the offline store on
// real browser storage (IndexedDB). Never available in production builds.

import { notFound } from 'next/navigation';
import { OfflineStoreHarnessClient } from './harness-client';

export const dynamic = 'force-dynamic';

export default function OfflineStoreHarnessPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <OfflineStoreHarnessClient />;
}
