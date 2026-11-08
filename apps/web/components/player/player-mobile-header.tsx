'use client';

import type { ReactNode } from 'react';
import { AccountMenu } from '@/components/account-menu';
import { useAppChrome } from '@/components/app-chrome-context';
import { MobileHeader } from '@/components/mobile-header';

export function PlayerMobileHeader({ title, action }: { title: string; action: ReactNode }) {
  const chrome = useAppChrome();
  return (
    <MobileHeader title={title} className="mb-4">
      {action}
      <AccountMenu
        listener={chrome.listener}
        mode={chrome.themeMode}
        onToggleMode={chrome.onToggleThemeMode}
      />
    </MobileHeader>
  );
}
