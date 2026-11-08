import type { ReactNode } from 'react';
import { SettingsFrame } from '@/components/settings/settings-frame';
import { requireAppAccess } from '@/lib/session';

// Settings chrome. The settings GROUP admits both roles — a Member owns their
// profile, playback, generation, and People pages. Every admin-only page keeps
// its own `requireAdmin` guard (defense in depth, matching how the app group
// double-guards layout and page); the hub filters what it renders by role.
export const dynamic = 'force-dynamic';

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  await requireAppAccess();
  return <SettingsFrame>{children}</SettingsFrame>;
}
