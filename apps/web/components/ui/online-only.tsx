'use client';

// Acts that need the server, while the app is offline: disabled in place with
// an "Offline" hint, never left to fail. A menu row marks itself
// (`MenuRow onlineOnly`); this region holds every button and field inside it.

import type { ReactNode } from 'react';
import { useOnline } from '@/lib/online-state';

/** What a control disabled by the connection says. */
export const OFFLINE_HINT = 'Offline';

/**
 * A `fieldset` disables its controls natively and `contents` keeps it out of
 * the layout, though not out of child selectors: a parent's `space-y` or
 * `last:` sees the fieldset, not what it wraps. Its title is the hover hint
 * every control inside inherits; `online-only` greys them (globals.css). A
 * portalled sheet or dialog is outside it: disable its trigger, or wrap its body.
 */
export function OnlineOnly({ children }: { children: ReactNode }) {
  const online = useOnline();
  return (
    <fieldset
      disabled={!online}
      title={online ? undefined : OFFLINE_HINT}
      className="online-only contents"
    >
      {children}
    </fieldset>
  );
}
