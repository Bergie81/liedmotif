'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import type { AssistantStanding } from '@liedmotif/shared';
import { getChrome, type ChromeData } from '@/lib/api-client';
import type { AnswerLinkTargets } from '@/lib/assistant/answer-links';
import { readBrowserPreference, writeBrowserPreference } from '@/lib/browser-preferences';
import { cn } from '@/lib/cn';
import { AccountMenu, type Listener } from './account-menu';
import { AppChromeContext, type AppChromeContextValue } from './app-chrome-context';
import { AssistantDock } from './assistant/assistant-dock';
import { assistantPlayerState } from './assistant/player-state';
import {
  deriveGenerationHeadroom,
  getPageIdentity,
  isSettingsDetailRoute,
} from './app-shell-model';
import { HeadroomLink, PrimaryNavigation } from './app-navigation';
import { MobileHeader } from './mobile-header';
import { usePlayerContext } from './player/player-provider';
import { useTrackPreviewAnnouncement } from './player/preview-announcer';

/** The shell's chrome state: usage is `null` until its streamed read resolves. */
type ChromeState = {
  usage: ChromeData['usage'] | null;
  activeSession: ChromeData['activeSession'];
};

export function AppShell({
  children,
  listener,
  viewerRole,
  ownVoiceOffered,
  initialActiveSession,
  usagePromise,
  assistantAvailable,
  assistantLinks,
  assistantStanding,
}: {
  children: ReactNode;
  listener: Listener;
  viewerRole: AppChromeContextValue['viewerRole'];
  ownVoiceOffered: boolean;
  initialActiveSession: ChromeData['activeSession'];
  usagePromise: Promise<ChromeData['usage'] | null>;
  /** Whether this viewer has the Assistant: decides if its launcher shows at all. */
  assistantAvailable: boolean;
  /** Where the Assistant's answers may lead this viewer. */
  assistantLinks: AnswerLinkTargets;
  /** Where this viewer stands with their daily Assistant allowance, when they have the Assistant. */
  assistantStanding: AssistantStanding | null;
}) {
  const pathname = usePathname() ?? '/';
  const previousPathname = useRef(pathname);
  const [chrome, setChrome] = useState<ChromeState>({
    usage: null,
    activeSession: initialActiveSession,
  });
  const [railExpanded, setRailExpanded] = useState(false);
  const [themeMode, setThemeMode] = useState<'night' | 'light'>('night');
  const { playback } = usePlayerContext();
  const isPlayer = pathname === '/player' || pathname.startsWith('/player/');
  const hasSettingsDetailHeader = isSettingsDetailRoute(pathname);
  // The live cross-route controller outranks the server-known active session:
  // it exists the moment playback starts, without waiting for a diagnostics
  // refresh, and its summary is the fresher of the two. A playing Playlist has
  // no session at all — the live controller alone keeps the bar up.
  const miniPlayerSession = playback?.session ?? chrome.activeSession;
  // A page-local track preview keeps the bar up too — with nothing engaged and
  // no active session it is the only thing the bar has to mirror.
  const previewAnnouncement = useTrackPreviewAnnouncement();
  const showMiniPlayer =
    !isPlayer && (previewAnnouncement !== null || playback !== null || miniPlayerSession !== null);
  const headroom = chrome.usage ? deriveGenerationHeadroom(chrome.usage) : null;
  const headroomHref = viewerRole === 'member' ? '/settings/my-budget' : '/settings/limits';

  // The layout streams the usage read so the shell paints before the budget
  // counts resolve; adopt it unless a navigation refetch already brought a
  // fresher readout.
  useEffect(() => {
    let cancelled = false;
    void usagePromise.then((usage) => {
      if (cancelled || usage === null) return;
      setChrome((current) => (current.usage === null ? { ...current, usage } : current));
    });
    return () => {
      cancelled = true;
    };
  }, [usagePromise]);

  // At most one chrome request in flight: a caller that arrives while one
  // is pending joins it instead of opening a second (see `AppChromeContext`).
  // Every read lands in the shell, so a page that just changed what the chrome
  // shows (a saved limit) refreshes the sidebar by asking for one.
  const chromeInFlightRef = useRef<ReturnType<typeof getChrome> | null>(null);
  const fetchChrome = useCallback(() => {
    chromeInFlightRef.current ??= getChrome()
      .then((result) => {
        if (result.ok) setChrome(result.data);
        return result;
      })
      .finally(() => {
        chromeInFlightRef.current = null;
      });
    return chromeInFlightRef.current;
  }, []);

  useEffect(() => {
    if (previousPathname.current === pathname) return;
    previousPathname.current = pathname;
    void fetchChrome();
  }, [pathname, fetchChrome]);

  useEffect(() => {
    const root = document.documentElement;
    const expanded = readBrowserPreference('liedmotif-rail-expanded') === 'true';
    setRailExpanded(expanded);
    root.classList.toggle('rail-expanded', expanded);
    const frame = requestAnimationFrame(() => root.classList.add('rail-anim'));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    setThemeMode(document.documentElement.classList.contains('light') ? 'light' : 'night');
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('rail-player', showMiniPlayer);
    return () => root.classList.remove('rail-player');
  }, [showMiniPlayer]);

  function toggleRail() {
    setRailExpanded((current) => {
      const next = !current;
      document.documentElement.classList.toggle('rail-expanded', next);
      writeBrowserPreference('liedmotif-rail-expanded', String(next));
      return next;
    });
  }

  const toggleThemeMode = useCallback(() => {
    setThemeMode((current) => {
      const next = current === 'night' ? 'light' : 'night';
      document.documentElement.classList.toggle('light', next === 'light');
      writeBrowserPreference('liedmotif-theme', next);
      return next;
    });
  }, []);

  const chromeContext = useMemo<AppChromeContextValue>(
    () => ({
      listener,
      viewerRole,
      ownVoiceOffered,
      themeMode,
      onToggleThemeMode: toggleThemeMode,
      fetchChrome,
    }),
    [listener, viewerRole, ownVoiceOffered, themeMode, toggleThemeMode, fetchChrome],
  );

  return (
    <div className="min-h-[100dvh] desk:pr-(--assistant)">
      {!isPlayer && !hasSettingsDetailHeader ? (
        <MobileHeader
          title={getPageIdentity(pathname)}
          className="mx-auto max-w-(--shell-col) px-4 pt-4"
        >
          <HeadroomLink headroom={headroom} href={headroomHref} compact />
          <AccountMenu listener={listener} mode={themeMode} onToggleMode={toggleThemeMode} />
        </MobileHeader>
      ) : null}

      <main
        className={cn(
          'relative mx-auto max-w-(--shell-col) space-y-6 px-4 pt-4 desk:mr-auto desk:max-w-[1120px] desk:ml-[max(calc(var(--rail)+24px),calc(50vw-var(--assistant)/2-560px))] desk:px-10 desk:pt-6 rail-anim:transition-[margin-left] rail-anim:duration-150 rail-anim:ease-[ease]',
          showMiniPlayer
            ? 'pb-[calc(var(--tab-h)+var(--mini-h)+32px+env(safe-area-inset-bottom,0px))] desk:pb-12'
            : 'pb-[calc(var(--tab-h)+32px+env(safe-area-inset-bottom,0px))] desk:pb-12',
        )}
      >
        <AppChromeContext.Provider value={chromeContext}>{children}</AppChromeContext.Provider>
      </main>

      <PrimaryNavigation
        pathname={pathname}
        listener={listener}
        headroom={headroom}
        headroomHref={headroomHref}
        activeSession={miniPlayerSession}
        showMiniPlayer={showMiniPlayer}
        railExpanded={railExpanded}
        onToggleRail={toggleRail}
        themeMode={themeMode}
        onToggleThemeMode={toggleThemeMode}
      />
      {/* No launcher on the Player: in its one-column layout the seek bar and
          the transport's last control end up under that corner. */}
      {assistantAvailable ? (
        <AssistantDock
          links={assistantLinks}
          launcherHidden={isPlayer}
          standing={assistantStanding}
          player={assistantPlayerState(playback)}
        />
      ) : null}
    </div>
  );
}
