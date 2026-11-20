import { LoginForm } from '@/components/auth/login-form';
import {
  cardClass,
  displayHeadingClass,
  eyebrowClass,
  LiedmotifMark,
  LiedmotifWordmark,
} from '@/components/ui/design-system';
import { isAccountEmailEnabled } from '@/lib/env';
import { redirectAwayFromLogin } from '@/lib/auth/session';

// Login is shown only when an admin exists and nobody is signed in. The guard
// forwards to /setup (no admin yet) or / (already signed in).
export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  await redirectAwayFromLogin();
  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-[460px] flex-col justify-center px-4 py-10 desk:px-10">
      <div className="mb-10 flex items-center gap-3">
        <LiedmotifMark className="h-8 w-8" />
        <LiedmotifWordmark className="text-[22px]" />
      </div>
      <p className={eyebrowClass}>Your Listening Space</p>
      <h1 className={`${displayHeadingClass} mt-3`}>Welcome Back</h1>
      <div className={`${cardClass} mt-7`}>
        <LoginForm canResetByEmail={isAccountEmailEnabled()} />
      </div>
    </main>
  );
}
