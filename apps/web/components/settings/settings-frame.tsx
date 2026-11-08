'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { OnlineOnly } from '@/components/ui/online-only';

/** The one Settings page that draws its own online-only region: its "On this
 *  device" section changes only this browser's storage, so it stays outside
 *  and keeps working offline. A layout's region cannot leave a hole for one
 *  section of a page, so the page holds the region instead. */
const OWN_ONLINE_ONLY_PAGE = '/settings/storage';

/** Settings are saved on the server, so offline the frame is read-only. */
export function SettingsFrame({ children }: { children: ReactNode }) {
  const body = (
    <div className="mx-auto w-full min-w-0 max-w-[1040px] space-y-6 desk:space-y-8">{children}</div>
  );
  return usePathname() === OWN_ONLINE_ONLY_PAGE ? body : <OnlineOnly>{body}</OnlineOnly>;
}
