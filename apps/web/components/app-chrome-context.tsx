'use client';

import { createContext, useContext } from 'react';
import type { ApiResult, ChromeData } from '@/lib/http/api-client';
import type { Listener } from './account-menu';

export interface AppChromeContextValue {
  listener: Listener;
  /** The viewer's role, for PRESENTATION ONLY — deciding what a screen offers
   * (e.g. Member-gated controls render nothing). Every authorization
   * boundary stays the server-side route/page guard; this field must never be the
   * thing that protects something. */
  viewerRole: 'admin' | 'member';
  /** Whether own-voice controls may render for this viewer (Admin, and the
   * instance's `OWN_VOICE_ENABLED` switch on) — presentation only, like
   * `viewerRole`; the session routes refuse own-voice requests on their own. */
  ownVoiceOffered: boolean;
  /** Whether a text LLM is configured, so a screen offers only free text it can
   *  read (the More Like This context) — presentation only; the routes refuse
   *  such text on their own. */
  llmConfigured: boolean;
  themeMode: 'night' | 'light';
  onToggleThemeMode: () => void;
  /** The shell-owned chrome read, shared so a route change and a page's
   * own need for the active Session (the /player discovery) join ONE request
   * instead of firing identical concurrent ones. Every successful read also
   * updates the shell's own chrome (the sidebar headroom chip). */
  fetchChrome: () => Promise<ApiResult<ChromeData>>;
}

export const AppChromeContext = createContext<AppChromeContextValue | null>(null);

export function useAppChrome(): AppChromeContextValue {
  const value = useContext(AppChromeContext);
  if (!value) throw new Error('useAppChrome requires an AppShell ancestor');
  return value;
}
