'use client';

import { useState } from 'react';
import { wipeDeviceOffline } from '@/lib/offline/device-offline';

export function useSignOut() {
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    // Better Auth rejects bodyless POSTs without an explicit JSON content type.
    const response = await fetch('/api/auth/sign-out', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }).catch(() => null);

    if (!response?.ok) {
      setBusy(false);
      return;
    }

    // Offline music belongs to the account, not the device: a signed-out
    // browser keeps none of it for the next person.
    await wipeDeviceOffline();
    window.location.assign('/login');
  }

  return { busy, signOut };
}
