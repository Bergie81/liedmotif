import { redirect } from 'next/navigation';
import { SignOutButton } from '@/components/settings/sign-out-button';
import {
  cardClass,
  displayHeadingClass,
  eyebrowClass,
  LiedmotifMark,
  LiedmotifWordmark,
} from '@/components/ui/design-system';
import { resolveAccountState } from '@/lib/auth/session';

// The stated destination for a signed-in but disabled account — never /login,
// which would bounce straight back into the app guards. Anyone else is routed
// where they belong.
export const dynamic = 'force-dynamic';

export default async function AccountDisabledPage() {
  const { kind } = await resolveAccountState();
  if (kind === 'active') redirect('/');
  if (kind === 'none') redirect('/login');
  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-[460px] flex-col justify-center px-4 py-10 desk:px-10">
      <div className="mb-10 flex items-center gap-3">
        <LiedmotifMark className="h-8 w-8" />
        <LiedmotifWordmark className="text-[22px]" />
      </div>
      <p className={eyebrowClass}>Account Status</p>
      <h1 className={`${displayHeadingClass} mt-3`}>This Account Is Disabled</h1>
      <p className="mt-3 text-[14px] leading-relaxed text-muted">
        Your account has been disabled by the person running this instance. Your music and playlists
        are kept — ask them to re-enable your access.
      </p>
      <div className={`${cardClass} mt-7`}>
        <SignOutButton />
      </div>
    </main>
  );
}
