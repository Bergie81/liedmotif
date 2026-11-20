'use client';

import { WifiOff } from 'lucide-react';
import { useOnline } from '@/lib/online-state';
import { iconButtonClass } from './design-system';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

/**
 * An options sheet's sign that it is showing the listen-only set: offline its
 * server rows go dark or drop out, and this says why. Present only while offline.
 */
export function OfflineSheetMark() {
  if (useOnline()) return null;
  return (
    <Popover>
      <PopoverTrigger className={iconButtonClass} aria-label="Offline: Why Options Are Missing">
        <WifiOff className="h-[18px] w-[18px] text-warn" aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Offline">
        <p>
          Offline — only music kept on this device plays. Options that need the server come back
          when you&rsquo;re online.
        </p>
      </PopoverContent>
    </Popover>
  );
}
