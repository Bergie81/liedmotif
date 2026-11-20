'use client';

// Sign out via Better Auth's endpoint, then return to the login screen.

import { LogOut } from 'lucide-react';
import { dangerButtonClass } from '@/components/ui/design-system';
import { useSignOut } from './use-sign-out';

export function SignOutButton() {
  const { busy, signOut } = useSignOut();
  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      className={`${dangerButtonClass} w-full`}
    >
      <LogOut className="h-4 w-4" aria-hidden />
      {busy ? 'Signing Out…' : 'Sign Out'}
    </button>
  );
}
